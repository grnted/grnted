// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Pictures and the words they draw: 1.4.5 Images of Text and 1.1.1 Non-text Content (probe `picture-text`, read from
// the probe's own findings: axe's image-alt and the names test are other tests with labs of their own).
//
// Source of truth. SC 1.4.5: "If the technologies being used can achieve the visual presentation, text is used to
// convey information rather than images of text", except where the image is customizable or the presentation is
// essential ("Logotypes ... are considered essential"). Image of text: "text that has been rendered in a non-text
// form (e.g., an image) in order to achieve a particular visual effect. Note: This does not include text that is part
// of a picture that contains significant other visual content" (graphs, screenshots, diagrams). The W3C's ACT rule
// "HTML images contain no text" fails an `img` whose SVG source holds a text element, with or without a complete
// alt text, and a CSS background of text; it passes logos, decoration, and text in an inline `svg`.
// SC 1.1.1: "All non-text content that is presented to the user has a text alternative that serves the equivalent
// purpose". F30: text alternatives that are not alternatives (file names, placeholder text). F3: CSS images that
// convey important information. F38/H67: only pure decoration is hidden. G74/G73: a long description next to the
// picture, with a short alternative that names it, is sufficient. G94: a short alternative that serves the purpose.
//
// The answer by construction. Every picture is an SVG file (the only kind the test reads) made by a generator here:
// - a NOTICE is lines of words on a plain ground (one of the layouts below): an image of text (1.4.5 fails,
//   whatever its alt text), and its words are its information (1.1.1 fails when neither its alternative nor the
//   page's text gives them);
// - a DIAGRAM is a drawing (a route, a floor plan, a bill) with labels and a written instruction: not an image of
//   text; its instruction is information (1.1.1 fails when it is marked decorative, or named only by its kind or a
//   file name, and the page's text does not give the instruction);
// - the look-alikes are pictures that pass: logos, a CAPTCHA, charts, maps with labels only, boxes of words (an
//   organisation chart, a flow chart), a photo with a caption inside the file, words that are never drawn, real
//   text in an inline SVG, decorative backgrounds; and for 1.1.1 the same notices and diagrams with a complete
//   alternative, a description beside them (a paragraph, a list of terms, a table, a figure caption, text behind a
//   toggle, aria-describedby), a link to a text version, or inside a link.
// - not counted ('any'): what is a failure but needs judgement or eyes this test does not have, or where either
//   answer is defensible: four words or fewer (a title or a logo), words drawn as outlines or in a bitmap, a
//   two-column flyer, a notice beside a large illustration, a schedule grid, a thumbnail too small to read, a
//   background that is cut off, an alternative that names the subject but leaves the instruction out, an
//   alternative that says something else while the page's text gives the words, and a picture with no alt attribute
//   (axe's failure, not this test's).
// Real-site-like wrappers (the markup the picture sits in): WordPress block figures, Drupal media, Finalsite and
// CivicPlus content blocks, Elementor widgets, picture/srcset, lazy loading with and without a size, data: addresses,
// a slideshow's first slide, a table cell, a narrow column.
import { picturesProbe } from '../../../src/probes/pictures.js';
import { applyHazard, hash, parts, pick, render, rng, solidPng } from '../page.js';
import type { Expectation, Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];
const P: Expectation = { verdict: 'pass' };
const F: Expectation = { verdict: 'fail', count: 1 };
const A: Expectation = { verdict: 'any' };

// ---- Words ------------------------------------------------------------------------------------------

/** Notices as agencies post them: a title and the lines under it. No two share their key words. */
const NOTICES: readonly (readonly string[])[] = [
  ['Yearbook photo retakes', 'Tuesday, May 19 · 9 to 11 a.m.', 'Music room, east wing', 'Bring the signed retake slip.'],
  ['Hydrant flushing this week', 'Crews work on Juniper and Alder streets', 'Water may look cloudy for an hour', 'Run the cold tap until it clears.'],
  ['Storytime moves outdoors', 'Thursday mornings at 10:30', 'Meet under the oak behind the branch', 'Blankets and strollers welcome'],
  ['Route 14 detour', 'Starts Monday, June 8', 'Buses skip the Fern Street stops', 'Board at Harbor and Third instead.'],
  ['Leaf pickup schedule', 'North side: first Tuesday of November', 'South side: second Tuesday of November', 'Use paper bags only, no plastic.'],
  ['Pool closed for repairs', 'The lap pool reopens Saturday, July 11', 'The wading pool stays open', 'Passes are extended by two weeks.'],
  ['Kindergarten roundup', 'Wednesday, March 4, from 4 to 6 p.m.', 'Bring a birth certificate and a utility bill', 'Maple Elementary gymnasium'],
  ['Burn ban in effect', 'No open fires until further notice', 'Gas grills are allowed', 'Call 555-0142 to report smoke.'],
  ['Free tax help', 'Saturdays in February, 9 a.m. to noon', 'Second floor meeting room', 'Bring last year’s return and photo ID.'],
  ['Polling place change', 'Precinct 7 now votes at the grange hall', '412 Orchard Road', 'Doors open at 7 a.m. on election day.'],
  ['Boil water advisory lifted', 'Tests on Friday came back clear', 'Flush ice makers and replace filters', 'Thank you for your patience.'],
  ['Senior lunch menu', 'Monday: vegetable soup and rolls', 'Wednesday: baked chicken with rice', 'Friday: fish tacos and slaw'],
  ['Trail closed past mile 3', 'A washout took the footbridge', 'Turn back at the picnic shelter', 'Repairs begin in September.'],
  ['Board vacancy', 'One seat on the parks board is open', 'Letters of interest are due April 30', 'Send them to the district clerk.'],
  ['Summer meals for kids', 'Free breakfast and lunch, ages 1 to 18', 'Weekdays at Cedar Park pavilion', 'No sign-up needed.'],
  ['Late start Wednesday', 'Classes begin two hours late on January 14', 'Buses run two hours later too', 'Breakfast is not served.'],
  ['Street sweeping', 'Odd-numbered side on the first Monday', 'Even-numbered side on the third Monday', 'Move parked cars by 8 a.m.'],
  ['Lost and found', 'Coats and lunch boxes are in the front hall', 'Unclaimed items go to charity on June 12', 'Label everything with a name.'],
  ['Flu shot clinic', 'Thursday, October 8, noon to 6 p.m.', 'County health annex, room B', 'Wear short sleeves and bring an insurance card.'],
  ['Meter reader visits', 'Staff carry a district badge and tablet', 'They never ask to come indoors', 'Call the office if you are unsure.'],
  ['Book sale this weekend', 'Hardcovers one dollar, paperbacks fifty cents', 'Fill a bag for five dollars on Sunday', 'Cash or check only.'],
  ['Crosswalk signal out', 'The light at Pine and Seventh is dark', 'Treat the corner as a four-way stop', 'A crossing guard is on duty at school hours.'],
  ['Garden plots available', 'Twelve raised beds remain at Mill Creek', 'Forty dollars for the season', 'Water and tools are provided.'],
  ['Paratransit holiday hours', 'No service on Thursday, November 26', 'Reduced service on Friday', 'Book rides three days ahead.'],
];

const DIAGRAMS: readonly { kind: string; title: string; labels: readonly string[]; says: string; file: string }[] = [
  { kind: 'Map', title: 'Drop-off map', labels: ['SOUTH LOT', 'KISS AND GO'], says: 'Drive past the flagpole and stop only at the yellow kerb.', file: 'drop-off-map' },
  { kind: 'Diagram', title: 'Sewer lateral diagram', labels: ['Cleanout', 'Property line'], says: 'The owner maintains the pipe from the house to the property line.', file: 'lateral' },
  { kind: 'Map', title: 'Detour map', labels: ['Alder Avenue', 'Fern Lane'], says: 'Temporary stop 126 is on Alder Avenue at Fern Lane.', file: 'detour' },
  { kind: 'Floor plan', title: 'Library floor plan', labels: ['WEST ENTRANCE', 'HOLDS'], says: 'Enter by the west door and turn right at the desk for the hold shelf.', file: 'floor-plan' },
  { kind: 'Chart', title: 'Bill guide', labels: ['Account', 'Usage'], says: 'Pay the amount in box C by the date printed beside it.', file: 'bill-guide' },
  { kind: 'Map', title: 'Parade route', labels: ['START', 'FINISH'], says: 'Main Street is closed to cars from Second to Ninth until noon.', file: 'parade-route' },
  { kind: 'Graphic', title: 'Recycling guide', labels: ['Blue cart', 'Green cart'], says: 'Glass jars go to the depot, never in either cart.', file: 'recycling' },
  { kind: 'Diagram', title: 'Evacuation diagram', labels: ['Stair A', 'Stair B'], says: 'Gather at the flagpole in the north parking lot after leaving.', file: 'evacuation' },
];

// Text of the page that has nothing to do with any picture here: it shares no word or number with a notice or a diagram.
const UNRELATED = ['Subscribe to our newsletter to hear from us every fortnight.', 'Older postings are archived and can be emailed on request.', 'This page is reviewed every month by the communications team.'];

// ---- Pictures ---------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const svgFile = (w: number, h: number, inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`;
const FONTS = ['Arial, Helvetica, sans-serif', 'Georgia, serif', 'Verdana, sans-serif', '"Trebuchet MS", sans-serif'];
const GROUNDS: readonly [string, string][] = [['#f4efe2', '#1a1a1a'], ['#ffffff', '#12395b'], ['#e9f1f7', '#102a43'], ['#12395b', '#ffffff'], ['#fff8e1', '#3b2f00'], ['#1f3d2b', '#f3f6ee']];

export const NOTICE_LAYOUTS = ['left-plain', 'left-card', 'centre-card', 'right-plain', 'title-band', 'side-stripe', 'rounded-card', 'clear-ground', 'gradient', 'one-line', 'tspans', 'portrait', 'wide-banner', 'ruled-title', 'dark-ground'] as const;
export type NoticeLayout = (typeof NOTICE_LAYOUTS)[number];
interface Drawn { svg: string; w: number; h: number }

/** A notice drawn as an SVG file in one of the layouts: always lines of words on a plain ground. */
export function noticeSvg(lines: readonly string[], layout: NoticeLayout, r: () => number): Drawn {
  const font = pick(r, FONTS);
  let [bg, fg] = pick(r, GROUNDS);
  if (layout === 'dark-ground') [bg, fg] = ['#12395b', '#ffffff'];
  const portrait = layout === 'portrait';
  const wide = layout === 'wide-banner';
  const text = layout === 'one-line' ? [lines.slice(1).find((l) => l.split(/\s+/).length >= 5) ?? `${lines[0]}: ${lines[1]}`] : wide ? lines.slice(0, 2) : lines;
  const w = portrait ? 480 : wide ? 1100 : 640;
  const size = wide ? 30 : portrait ? 17 : 22;
  const gap = Math.round(size * 1.75);
  const top = layout === 'title-band' ? 84 : 58;
  const h = portrait ? 520 : Math.max(layout === 'one-line' ? 100 : 160, top + gap * (text.length - 1) + 44);
  const anchor = layout === 'centre-card' || portrait ? 'middle' : layout === 'right-plain' ? 'end' : 'start';
  const x = anchor === 'middle' ? w / 2 : anchor === 'end' ? w - 36 : layout === 'side-stripe' ? 52 : 36;
  const y0 = portrait ? 150 : top;
  let ground = layout === 'clear-ground' ? '' : `<rect width="${w}" height="${h}" fill="${bg}"/>`;
  if (layout === 'clear-ground') fg = '#1a1a1a';
  if (layout === 'gradient') ground = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dfe9f2"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>`;
  if (layout === 'gradient') fg = '#102a43';
  let extra = '';
  if (layout === 'left-card' || layout === 'centre-card' || portrait) extra = `<rect x="12" y="12" width="${w - 24}" height="${h - 24}" fill="none" stroke="${fg}" stroke-width="3"/>`;
  if (layout === 'rounded-card') extra = `<rect x="14" y="14" width="${w - 28}" height="${h - 28}" rx="18" fill="${bg}" stroke="${fg}" stroke-width="4"/>`;
  if (layout === 'side-stripe') extra = `<rect width="14" height="${h}" fill="${fg}"/>`;
  if (layout === 'ruled-title') extra = `<path d="M36 ${y0 + 14} H${w - 36}" stroke="${fg}" stroke-width="2"/>`;
  let body: string;
  if (layout === 'title-band') {
    // A band with the title over a body with the rest: two grounds, one above the other.
    extra = `<rect width="${w}" height="56" fill="${fg}"/>`;
    body = `<text x="${x}" y="38" font-size="26" font-weight="700" fill="${bg}">${esc(text[0]!)}</text>${text.slice(1).map((l, i) => `<text x="${x}" y="${y0 + gap * i + 14}" font-size="${size}">${esc(l)}</text>`).join('')}`;
  } else if (layout === 'tspans') {
    body = `<text x="${x}" y="${y0}" font-size="${size}">${text.map((l, i) => `<tspan x="${x}" dy="${i ? gap : 0}">${esc(l)}</tspan>`).join('')}</text>`;
  } else {
    body = text.map((l, i) => `<text x="${x}" y="${y0 + gap * i}" font-size="${i === 0 && text.length > 1 ? size + 6 : size}"${i === 0 && text.length > 1 ? ' font-weight="700"' : ''}>${esc(l)}</text>`).join('');
  }
  return { svg: svgFile(w, h, `${ground}${extra}<g font-family='${font}' fill="${fg}" text-anchor="${anchor}">${body}</g>`), w, h };
}

/** A drawing with labels and one written instruction (a route, a plan): not an image of text. */
export function diagramSvg(d: (typeof DIAGRAMS)[number], r: () => number, opts: { says?: boolean } = {}): Drawn {
  const w = 640, h = 260;
  const [a, b] = [Math.round(60 + r() * 60), Math.round(380 + r() * 80)];
  const says = opts.says === false ? '' : `<text x="56" y="236" font-size="17">${esc(d.says)}</text>`;
  return {
    svg: svgFile(w, h, `<rect width="${w}" height="${h}" fill="#eff3e9"/><rect x="48" y="36" width="544" height="150" fill="#d4e1d2" stroke="#305f53" stroke-width="3"/>`
      + `<path d="M8 ${150 - r() * 20} H${a + 180} V118 H${b}" fill="none" stroke="#175a53" stroke-width="6"/><circle cx="${a + 180}" cy="118" r="9" fill="#b3261e"/>`
      + `<rect x="${b}" y="96" width="120" height="52" fill="#edce82" stroke="#305f53" stroke-width="2"/>`
      + `<g font-family="Arial, Helvetica, sans-serif" fill="#1a1a1a"><text x="${a}" y="70" font-size="16" font-weight="700">${esc(d.labels[0]!)}</text><text x="${b + 12}" y="128" font-size="15" font-weight="700">${esc(d.labels[1]!)}</text>${says}</g>`),
    w, h,
  };
}

const LOOK_ALIKES_145 = ['logo-home-link', 'logo-class', 'logo-alt', 'sponsor-footer', 'captcha', 'map-labels', 'diagram-instruction', 'bar-chart', 'line-chart', 'pie-chart', 'org-chart', 'flow-chart', 'timeline', 'photo-caption', 'words-not-drawn', 'inline-svg', 'book-cover', 'icon-facts', 'sample-alt', 'sample-figcaption', 'sample-heading', 'sample-heading-wrapped',
  // The review's look-alikes (Sol r1, S2, S4, S6).
  'words-kept-out', 'bars-labels-inside', 'boxes-apart', 'smil-hidden', 'sized-by-media'] as const;
type LookAlike145 = (typeof LOOK_ALIKES_145)[number];
const NOT_COUNTED_145 = ['three-words', 'four-words', 'outlined-words', 'bitmap-notice', 'two-columns', 'mixed-edges', 'beside-illustration', 'schedule-grid', 'thumbnail', 'sprite-view'] as const;
type NotCounted145 = (typeof NOT_COUNTED_145)[number];

const TEXT = (x: number, y: number, s: string, extra = '') => `<text x="${x}" y="${y}" font-size="16"${extra}>${esc(s)}</text>`;
const G = (inner: string) => `<g font-family="Arial, Helvetica, sans-serif" fill="#1a1a1a">${inner}</g>`;

/** A picture that is not an image of text, or that cannot be counted, with the markup it sits in. */
function otherPicture(kind: LookAlike145 | NotCounted145, lines: readonly string[], r: () => number): { svg: string; w: number; h: number; html: (src: string) => string; file?: Uint8Array } {
  const name = 'Birch Valley Water District';
  const img = (w: number, h: number, alt: string, extra = '') => (src: string) => `<img id="subject" src="${src}" width="${w}" height="${h}" alt="${esc(alt)}"${extra}>`;
  const wordmark = svgFile(480, 90, `<rect width="480" height="90" fill="#12395b"/><text x="20" y="40" font-family="Georgia, serif" font-size="26" fill="#ffffff">${name}</text><text x="20" y="70" font-family="Georgia, serif" font-size="16" fill="#ffffff">Clean water for the valley since 1952</text>`);
  switch (kind) {
    case 'logo-home-link': return { svg: wordmark, w: 480, h: 90, html: (src) => `<p><a href="/">${img(480, 90, name)(src)}</a></p>` };
    case 'logo-class': return { svg: wordmark, w: 480, h: 90, html: (src) => `<div class="site-branding">${img(480, 90, name, ' class="custom-logo"')(src)}</div>` };
    case 'logo-alt': return { svg: wordmark, w: 480, h: 90, html: img(480, 90, `${name} logo`) };
    case 'sponsor-footer': return { svg: wordmark, w: 480, h: 90, html: (src) => `<div class="sponsors"><p>Our sponsors</p><a href="https://sponsor.example/">${img(480, 90, name)(src)}</a></div>` };
    case 'captcha': return {
      svg: svgFile(260, 80, `<rect width="260" height="80" fill="#e2e9df"/><path d="M5 50 C 60 10, 120 80, 250 30" fill="none" stroke="#93a58a" stroke-width="3"/><text x="30" y="52" font-family="Courier New, monospace" font-size="30" letter-spacing="6" fill="#1a1a1a">K7 QP 4M XN 9T</text>`),
      w: 260, h: 80, html: (src) => `<div class="captcha-box">${img(260, 80, 'Verification code: type the characters shown to send the form')(src)}<p><label for="cap">Type the characters</label> <input id="cap" autocomplete="off"></p></div>`,
    };
    case 'map-labels': {
      const d = diagramSvg(pick(r, DIAGRAMS), r, { says: false });
      return { ...d, html: img(d.w, d.h, 'Map of the two stops and the road between them') };
    }
    case 'diagram-instruction': {
      const which = pick(r, DIAGRAMS);
      const d = diagramSvg(which, r);
      return { ...d, html: img(d.w, d.h, `${which.title}: ${which.says}`) };
    }
    case 'bar-chart': return {
      svg: svgFile(720, 380, `<rect width="720" height="380" fill="#fff"/><g fill="#2c6e8f"><rect x="120" y="200" width="90" height="120"/><rect x="300" y="150" width="90" height="170"/><rect x="480" y="90" width="90" height="230"/></g><path d="M80 320 H640" stroke="#333" stroke-width="2"/>${G(`<text x="360" y="40" font-size="18" text-anchor="middle">${esc(lines[0]!)} by season</text>${TEXT(165, 345, 'Autumn', ' text-anchor="middle"')}${TEXT(345, 345, 'Winter', ' text-anchor="middle"')}${TEXT(525, 345, 'Spring', ' text-anchor="middle"')}${TEXT(165, 190, '900', ' text-anchor="middle"')}${TEXT(345, 140, '1,100', ' text-anchor="middle"')}${TEXT(525, 80, '1,300', ' text-anchor="middle"')}`)}`),
      w: 720, h: 380, html: img(720, 380, 'Bar chart: 900 in autumn, 1,100 in winter and 1,300 in spring.'),
    };
    case 'line-chart': return {
      svg: svgFile(720, 320, `<rect width="720" height="320" fill="#fff"/><polyline points="90,240 240,200 390,150 540,170 660,90" fill="none" stroke="#b3261e" stroke-width="4"/><path d="M80 260 H680 M80 40 V260" stroke="#333" stroke-width="2" fill="none"/>${G(`${TEXT(90, 285, '2022')}${TEXT(240, 285, '2023')}${TEXT(390, 285, '2024')}${TEXT(540, 285, '2025')}${TEXT(640, 285, '2026')}<text x="380" y="28" font-size="18" text-anchor="middle">Riders each year, in thousands</text>`)}`),
      w: 720, h: 320, html: img(720, 320, 'Line chart: riders rose from 2022 to 2026, with a small dip in 2025.'),
    };
    case 'pie-chart': return {
      svg: svgFile(520, 320, `<rect width="520" height="320" fill="#fff"/><path d="M160 160 L160 50 A110 110 0 0 1 255 215 Z" fill="#2c6e8f"/><path d="M160 160 L255 215 A110 110 0 0 1 65 215 Z" fill="#edce82"/><path d="M160 160 L65 215 A110 110 0 0 1 160 50 Z" fill="#7a9e7e"/>${G(`${TEXT(320, 120, 'Roads 38%')}${TEXT(320, 160, 'Parks 31%')}${TEXT(320, 200, 'Safety 31%')}`)}`),
      w: 520, h: 320, html: img(520, 320, 'Pie chart of spending: roads 38%, parks 31%, safety 31%.'),
    };
    case 'org-chart': return {
      svg: svgFile(640, 280, `<rect width="640" height="280" fill="#fff"/><g fill="#e9f1f7" stroke="#102a43" stroke-width="2"><rect x="220" y="30" width="200" height="50"/><rect x="30" y="170" width="180" height="50"/><rect x="230" y="170" width="180" height="50"/><rect x="430" y="170" width="180" height="50"/></g><path d="M320 80 V130 M120 130 H520 M120 130 V170 M320 130 V170 M520 130 V170" stroke="#102a43" stroke-width="2" fill="none"/>${G(`${TEXT(320, 60, 'Board of Directors', ' text-anchor="middle"')}${TEXT(120, 200, 'Records Director', ' text-anchor="middle"')}${TEXT(320, 200, 'Road Director', ' text-anchor="middle"')}${TEXT(520, 200, 'Elections Director', ' text-anchor="middle"')}`)}`),
      w: 640, h: 280, html: img(640, 280, 'Organisation chart: the Records, Road and Elections directors report to the Board of Directors.'),
    };
    case 'flow-chart': return {
      svg: svgFile(420, 400, `<rect width="420" height="400" fill="#fff"/><g fill="#fff8e1" stroke="#3b2f00" stroke-width="2"><rect x="60" y="30" width="300" height="60"/><rect x="60" y="150" width="300" height="60"/><rect x="60" y="270" width="300" height="60"/></g><path d="M210 90 V150 M210 210 V270" stroke="#3b2f00" stroke-width="3"/><path d="M200 140 L210 150 L220 140 M200 260 L210 270 L220 260" stroke="#3b2f00" stroke-width="3" fill="none"/>${G(`${TEXT(210, 66, 'Send in the application', ' text-anchor="middle"')}${TEXT(210, 186, 'Staff review it in ten days', ' text-anchor="middle"')}${TEXT(210, 306, 'The permit is mailed to you', ' text-anchor="middle"')}`)}`),
      w: 420, h: 400, html: img(420, 400, 'Flow chart: send in the application, staff review it in ten days, then the permit is mailed to you.'),
    };
    case 'timeline': return {
      svg: svgFile(720, 200, `<rect width="720" height="200" fill="#fff"/><path d="M60 100 H660" stroke="#102a43" stroke-width="6"/><g fill="#b3261e"><circle cx="120" cy="100" r="12"/><circle cx="360" cy="100" r="12"/><circle cx="600" cy="100" r="12"/></g>${G(`${TEXT(120, 70, 'Design', ' text-anchor="middle"')}${TEXT(360, 70, 'Bids', ' text-anchor="middle"')}${TEXT(600, 70, 'Building', ' text-anchor="middle"')}${TEXT(120, 140, 'Spring', ' text-anchor="middle"')}${TEXT(360, 140, 'Summer', ' text-anchor="middle"')}${TEXT(600, 140, 'Autumn', ' text-anchor="middle"')}`)}`),
      w: 720, h: 200, html: img(720, 200, 'Timeline: design in spring, bids in summer, building in autumn.'),
    };
    case 'photo-caption': {
      // A photo inside the file (a bitmap, as a data: address) with one line of words under it.
      const png = Buffer.from(noisePng(96, 64, r)).toString('base64');
      return {
        svg: svgFile(640, 300, `<rect width="640" height="300" fill="#fff"/><image x="20" y="20" width="600" height="220" preserveAspectRatio="none" href="data:image/png;base64,${png}" xlink:href="data:image/png;base64,${png}"/>${G(TEXT(20, 275, `${lines[0]}: crews at work on Tuesday morning`))}`),
        w: 640, h: 300, html: img(640, 300, `${lines[0]}: crews at work on Tuesday morning`),
      };
    }
    case 'words-not-drawn': return {
      svg: svgFile(640, 120, `<rect width="640" height="120" fill="#f4efe2"/><path d="M40 60 C 200 10, 440 110, 600 60" fill="none" stroke="#2f4f3a" stroke-width="6"/><text x="36" y="60" font-size="22" display="none">${esc(lines.join('. '))}</text><defs><text id="u" x="36" y="90" font-size="22">${esc(lines[1]!)}</text></defs><text x="36" y="100" font-size="20" fill="#f4efe2">${esc(lines[2]!)}</text>`),
      w: 640, h: 120, html: img(640, 120, ''),
    };
    case 'inline-svg': return {
      svg: '', w: 640, h: 160,
      html: () => `<svg id="subject" width="640" height="160" viewBox="0 0 640 160"><rect width="640" height="160" fill="#f4efe2"/>${G(lines.slice(0, 3).map((l, i) => `<text x="36" y="${50 + i * 40}" font-size="22">${esc(l)}</text>`).join(''))}</svg>`,
    };
    case 'book-cover': return {
      svg: svgFile(300, 420, `<rect width="300" height="420" fill="#183f43"/><path d="M0 330 C 80 280, 160 380, 300 300 V420 H0 Z" fill="#497b71"/><path d="M40 420 V250 M100 420 V300 M230 420 V270" stroke="#cfbe80" stroke-width="10"/><circle cx="220" cy="210" r="34" fill="#f1d58a"/><g font-family="Georgia, serif" fill="#ffffff" text-anchor="middle"><text x="150" y="80" font-size="30">THE MARSH</text><text x="150" y="122" font-size="30">ALMANAC</text><text x="150" y="170" font-size="18">A year on the water</text></g>`),
      w: 300, h: 420, html: img(300, 420, 'The Marsh Almanac: a year on the water (book cover with reeds at dusk)'),
    };
    case 'icon-facts': return {
      svg: svgFile(720, 220, `<rect width="720" height="220" fill="#fff"/><g fill="#2c6e8f"><circle cx="110" cy="80" r="46"/><rect x="314" y="34" width="92" height="92" rx="12"/><path d="M560 126 L610 34 L660 126 Z"/></g>${G(`<text x="110" y="170" font-size="18" text-anchor="middle">412 miles of pipe</text><text x="360" y="170" font-size="18" text-anchor="middle">9 pump stations</text><text x="610" y="170" font-size="18" text-anchor="middle">3 reservoirs</text>`)}`),
      w: 720, h: 220, html: img(720, 220, 'The district has 412 miles of pipe, 9 pump stations and 3 reservoirs.'),
    };
    case 'sample-alt': case 'sample-figcaption': case 'sample-heading': case 'sample-heading-wrapped': {
      // A notice shown as a sample of how notices look: a block of text whose look may be the point. Said by the alt
      // text, the figure's caption, or the heading it comes right under (alone, or past one short paragraph and wrappers).
      const d = noticeSvg(lines, pick(r, ['left-plain', 'left-card', 'centre-card', 'rounded-card'] as const), r);
      const alt = lines.join('. ').replace(/\.\./g, '.');
      const pic = img(d.w, d.h, kind === 'sample-alt' ? `Specimen of the notice posted at each entrance: ${alt}` : alt);
      return {
        ...d,
        html: (src) => (kind === 'sample-alt' ? pic(src)
          : kind === 'sample-figcaption' ? `<figure class="wp-block-image size-large">${pic(src)}<figcaption class="wp-element-caption">A sample of the notice posted at each entrance</figcaption></figure>`
          : kind === 'sample-heading' ? `<h2>Sample notice</h2>${pic(src)}`
          : `<h3>Example of a posted notice</h3><p>Each entrance carries one like this.</p><div class="media media--type-image"><figure>${pic(src)}<figcaption>Posted at the west door</figcaption></figure></div>`),
      };
    }
    case 'words-kept-out': {
      // One word shown; the rest of the text element is kept out of sight (a part with display none): S2.
      const rest = lines.slice(1).join(' ');
      return { svg: svgFile(640, 120, `<rect width="640" height="120" fill="#f4efe2"/>${G(`<text x="36" y="70" font-size="26">Open<tspan display="none"> ${esc(rest)}</tspan></text>`)}`), w: 640, h: 120, html: img(640, 120, 'Open') };
    }
    case 'bars-labels-inside': return {
      // A title over two bars of different lengths with their labels inside them: the bars say how much (S4).
      svg: svgFile(640, 240, `<rect width="640" height="240" fill="#ffffff"/><rect x="30" y="80" width="${420 + Math.floor(r() * 120)}" height="56" fill="#cfe3f1"/><rect x="30" y="156" width="${200 + Math.floor(r() * 120)}" height="56" fill="#cfe3f1"/>${G(`<text x="40" y="50" font-size="24">Library visits this spring</text><text x="40" y="115" font-size="20">Alder Draw branch: 1,300 visits</text><text x="40" y="191" font-size="20">Willow Quay branch: 700</text>`)}`),
      w: 640, h: 240, html: img(640, 240, 'Bar chart of library visits this spring: Alder Draw branch 1,300, Willow Quay branch 700.'),
    };
    case 'boxes-apart': return {
      // Two boxes of one size set apart, each with a line of words in it, under a title (steps, options): S4.
      svg: svgFile(640, 260, `<rect width="640" height="260" fill="#ffffff"/><rect x="30" y="70" width="560" height="60" fill="#fff8e1"/><rect x="30" y="170" width="560" height="60" fill="#fff8e1"/>${G(`<text x="40" y="44" font-size="24">${esc(lines[0]!)}</text><text x="44" y="107" font-size="20">${esc(lines[1]!)}</text><text x="44" y="207" font-size="20">${esc(lines[2]!)}</text>`)}`),
      w: 640, h: 260, html: img(640, 260, lines.slice(0, 3).join('. ')),
    };
    case 'smil-hidden': {
      // A notice the file itself keeps out of sight from the start (SMIL): the page shows none of its words (S6).
      const d = noticeSvg(lines, 'left-card', r);
      return { ...d, svg: d.svg.replace(/<g font-family=/, '<g><set attributeName="opacity" to="0" begin="0s"/><g font-family=').replace(/<\/g><\/svg>$/, '</g></g></svg>'), html: img(d.w, d.h, '') };
    }
    case 'sized-by-media': {
      // A notice whose words the file hides at every size a page shows it at (a media query in the file): S6.
      const d = noticeSvg(lines, 'left-plain', r);
      return { ...d, svg: d.svg.replace(/(<svg[^>]*>)/, '$1<style>@media (max-width: 4000px) { text { display: none } }</style>'), html: img(d.w, d.h, '') };
    }
    case 'three-words': return { svg: svgFile(640, 120, `<rect width="640" height="120" fill="#12395b"/><text x="30" y="72" font-family="Georgia, serif" font-size="36" fill="#ffffff">${esc(lines[0]!.split(/\s+/).slice(0, 3).join(' '))}</text>`), w: 640, h: 120, html: img(640, 120, lines[0]!.split(/\s+/).slice(0, 3).join(' ')) };
    case 'four-words': return { svg: svgFile(640, 120, `<rect width="640" height="120" fill="#12395b"/><text x="30" y="72" font-family="Georgia, serif" font-size="34" fill="#ffffff">Spring book fair news</text>`), w: 640, h: 120, html: img(640, 120, 'Spring book fair news') };
    case 'outlined-words': return {
      // Letters drawn as shapes (what a drawing program's "convert to outlines" writes): no text element to read.
      svg: svgFile(640, 160, `<rect width="640" height="160" fill="#f4efe2"/><g fill="#1a1a1a">${Array.from({ length: 34 }, (_, i) => `<path d="M${30 + i * 17} ${50 + (i % 3) * 2} h9 v${26 + (i % 4) * 3} h-9 z M${32 + i * 17} 110 h7 v22 h-7 z"/>`).join('')}</g>`),
      w: 640, h: 160, html: img(640, 160, lines.join('. ')),
    };
    case 'bitmap-notice': return { svg: '', w: 320, h: 200, file: solidPng(64, 40, [244, 239, 226]), html: (src) => `<img id="subject" src="${src}" width="320" height="200" alt="${esc(lines.join('. '))}">` };
    case 'two-columns': return {
      svg: svgFile(640, 200, `<rect width="640" height="200" fill="#f4efe2"/>${G(`<text x="30" y="50" font-size="24" font-weight="700">${esc(lines[0]!)}</text>${TEXT(30, 100, 'When: Tuesday at nine')}${TEXT(340, 100, 'Where: the music room')}${TEXT(30, 140, 'Bring: the signed slip')}${TEXT(340, 140, 'Cost: nothing at all')}`)}`),
      w: 640, h: 200, html: img(640, 200, lines.join('. ')),
    };
    case 'mixed-edges': return {
      svg: svgFile(640, 220, `<rect width="640" height="220" fill="#f4efe2"/>${G(`<text x="320" y="56" font-size="28" font-weight="700" text-anchor="middle">${esc(lines[0]!)}</text>${lines.slice(1).map((l, i) => `<text x="36" y="${104 + i * 38}" font-size="20">${esc(l)}</text>`).join('')}`)}`),
      w: 640, h: 220, html: img(640, 220, lines.join('. ')),
    };
    case 'beside-illustration': return {
      svg: svgFile(720, 240, `<rect width="720" height="240" fill="#f4efe2"/><g fill="#497b71"><circle cx="590" cy="110" r="70"/><path d="M500 220 L590 60 L680 220 Z"/></g>${G(lines.map((l, i) => `<text x="36" y="${60 + i * 40}" font-size="${i ? 20 : 26}">${esc(l)}</text>`).join(''))}`),
      w: 720, h: 240, html: img(720, 240, lines.join('. ')),
    };
    case 'schedule-grid': return {
      svg: svgFile(640, 220, `<rect width="640" height="220" fill="#fff"/><path d="M20 60 H620 M20 110 H620 M20 160 H620 M220 20 V200 M420 20 V200" stroke="#555" stroke-width="1" fill="none"/>${G(`${TEXT(30, 45, 'Day')}${TEXT(230, 45, 'Opens')}${TEXT(430, 45, 'Closes')}${TEXT(30, 95, 'Monday')}${TEXT(230, 95, '9 a.m.')}${TEXT(430, 95, '5 p.m.')}${TEXT(30, 145, 'Saturday')}${TEXT(230, 145, '10 a.m.')}${TEXT(430, 145, '2 p.m.')}`)}`),
      w: 640, h: 220, html: img(640, 220, 'Hours: Monday 9 a.m. to 5 p.m., Saturday 10 a.m. to 2 p.m.'),
    };
    case 'thumbnail': {
      const d = noticeSvg(lines, 'left-card', r);
      return { ...d, html: (src) => `<img id="subject" src="${src}" width="96" height="${Math.round((96 * d.h) / d.w)}" alt="${esc(lines.join('. '))}">` };
    }
    case 'sprite-view': {
      const d = noticeSvg(lines, 'left-plain', r);
      return { ...d, html: (src) => `<img id="subject" src="${src}#notice" width="${d.w}" height="${d.h}" alt="${esc(lines.join('. '))}">` };
    }
  }
}

/** A small bitmap of noise (a photo's texture), as a PNG (stored deflate, like `solidPng`). */
function noisePng(w: number, h: number, r: () => number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type: string, data: number[]) => { const body = new Uint8Array([...[...type].map((c) => c.charCodeAt(0)), ...data]); return [...u32(data.length), ...body, ...u32(crc(body))]; };
  const raw: number[] = [];
  for (let y = 0; y < h; y++) { raw.push(0); for (let x = 0; x < w; x++) { const v = Math.floor(r() * 256); raw.push(v, Math.floor(r() * 256), 255 - v); } }
  const z: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) { const blk = raw.slice(i, i + 65535); z.push(i + 65535 >= raw.length ? 1 : 0, blk.length & 255, blk.length >> 8, ~blk.length & 255, (~blk.length >> 8) & 255, ...blk); }
  let a = 1, b = 0;
  for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; }
  z.push(...u32(((b << 16) | a) >>> 0));
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...u32(w), ...u32(h), 8, 2, 0, 0, 0]), ...chunk('IDAT', z), ...chunk('IEND', [])]);
}

// ---- Where the picture sits (real-site-like wrappers) ------------------------------------------------

export const WRAPPERS = ['plain', 'wp-figure', 'drupal-media', 'finalsite', 'civicplus', 'elementor', 'picture', 'srcset', 'lazy-sized', 'lazy-unsized', 'data-base64', 'data-utf8', 'slide', 'table-cell', 'narrow-column'] as const;
export type Wrapper = (typeof WRAPPERS)[number];

/** The markup around an `<img>` of the picture, as common site builders write it. `attrs`: alt and the like. */
function wrap(kind: Wrapper, d: Drawn, attrs: string, r: () => number): { html: string; css: string[]; files: Record<string, string | Uint8Array> } {
  const file = `/uploads/2026/${Math.floor(r() * 9000 + 1000)}/notice.svg`;
  const size = `width="${d.w}" height="${d.h}"`;
  const files: Record<string, string | Uint8Array> = { [file]: d.svg };
  const im = (src: string, more = size) => `<img id="subject" src="${src}" ${more} ${attrs}>`;
  switch (kind) {
    case 'plain': return { html: `<p>${im(file)}</p>`, css: [], files };
    case 'wp-figure': return { html: `<figure class="wp-block-image size-large">${im(file, `${size} class="wp-image-4821" decoding="async"`)}<figcaption class="wp-element-caption">Uploaded by the webmaster</figcaption></figure>`, css: ['.wp-block-image { margin: 0 0 1em; } .wp-block-image img { max-width: 100%; height: auto; }'], files };
    case 'drupal-media': return { html: `<article class="media media--type-image media--view-mode-full"><div class="field field--name-field-media-image field--type-image field__item">${im(file, `${size} loading="eager" typeof="foaf:Image" class="image-style-large"`)}</div></article>`, css: ['.media img { max-width: 100%; height: auto; }'], files };
    case 'finalsite': return { html: `<div class="fsElement fsContent" id="fsEl_2231"><div class="fsElementContent"><p>${im(file)}</p></div></div>`, css: ['.fsElementContent img { max-width: 100%; height: auto; }'], files };
    case 'civicplus': return { html: `<div class="fr-view widgetBody"><p>${im(file, `${size} class="fr-dib fr-draggable" style="width: ${d.w}px;"`)}</p></div>`, css: ['.fr-dib { display: block; margin: 5px auto; }'], files };
    case 'elementor': return { html: `<div class="elementor-element elementor-widget elementor-widget-image" data-widget_type="image.default"><div class="elementor-widget-container">${im(file, `${size} class="attachment-large size-large"`)}</div></div>`, css: ['.elementor-widget-image img { max-width: 100%; height: auto; }'], files };
    case 'picture': return { html: `<picture><source srcset="${file}" type="image/svg+xml"><img id="subject" src="/uploads/fallback.png" ${size} ${attrs}></picture>`, css: [], files: { ...files, '/uploads/fallback.png': solidPng(8, 8, [240, 240, 240]) } };
    case 'srcset': return { html: `<p>${im(file, `${size} srcset="${file} 1x, ${file} 2x"`)}</p>`, css: [], files };
    case 'lazy-sized': return { html: `<div style="height:1700px"><p>Scroll down.</p></div><p>${im(file, `${size} loading="lazy"`)}</p>`, css: [], files };
    case 'lazy-unsized': return { html: `<div style="height:2600px"><p>Scroll down.</p></div><p>${im(file, 'loading="lazy"')}</p>`, css: [], files };
    case 'data-base64': return { html: `<p>${im(`data:image/svg+xml;base64,${Buffer.from(d.svg).toString('base64')}`)}</p>`, css: [], files: {} };
    case 'data-utf8': return { html: `<p>${im(`data:image/svg+xml;utf8,${encodeURIComponent(d.svg)}`)}</p>`, css: [], files: {} };
    case 'slide': return {
      html: `<div class="slideshow" aria-roledescription="carousel" aria-label="Announcements"><div class="slide is-active">${im(file)}</div><div class="slide"><p>More postings.</p></div><p><button type="button" class="next">Next posting</button></p></div>`,
      css: ['.slide { display: none; } .slide.is-active { display: block; } .slideshow button { font: inherit; padding: 8px 16px; }'], files,
    };
    case 'table-cell': return { html: `<table class="layout"><tbody><tr><td>${im(file)}</td><td><p>Help</p></td></tr></tbody></table>`, css: ['table.layout td { vertical-align: top; padding: 8px; }'], files };
    case 'narrow-column': return { html: `<div class="col" style="max-width:${Math.max(380, Math.round(d.w * 0.62))}px">${im(file, `${size} style="max-width:100%;height:auto"`)}</div>`, css: [], files };
  }
}

// ---- The containers a picture is drawn in (the last fix round) ------------------------------------------

/**
 * Containers the picture test must read as the page is rendered: a web component that draws the picture in its
 * shadow root, one that places it through a slot into a panel of its shadow root, a wrapper with no box of its own
 * (`display: contents`) or an inline link that set `overflow: hidden` (neither cuts anything off), a card with paint
 * containment and a section with `content-visibility: auto`, each larger than the picture. The picture shows whole
 * in each, so what it fails anywhere else it fails here (the walk up through slots and shadow roots, and the boxes
 * that cut nothing off, must not lose it).
 */
const SHOWN_IN = ['component-shadow', 'component-slot', 'contents-wrapper', 'contained-card', 'cv-section', 'inline-link'] as const;
type ShownIn = (typeof SHOWN_IN)[number];
/**
 * Containers that keep all or part of the picture out of sight as the page is loaded: a disclosure component whose
 * panel in its shadow root has no height (closed), a reveal-on-scroll component clipped away by a clip path on its
 * host, a reveal-on-scroll wrapper clipped away, and a teaser panel of a component that shows its top only. What
 * people see once it is opened or revealed is not measured: never failed, and not counted.
 */
const KEPT_IN = ['component-closed-panel', 'component-reveal', 'reveal-wrapper', 'component-teaser'] as const;
type KeptIn = (typeof KEPT_IN)[number];

/** The markup and the scripts that put `inner` (a picture, or an element with a background) in a container. */
function drawnIn(where: ShownIn | KeptIn, inner: string): { html: string; init: string[] } {
  const define = (tag: string, shadow: string, host = '') => `if (!customElements.get('${tag}')) customElements.define('${tag}', class extends HTMLElement { connectedCallback() { if (this.shadowRoot) return; ${host}this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(shadow)}; } });`;
  switch (where) {
    case 'component-shadow': return { html: '<notice-card></notice-card>', init: [define('notice-card', `<div class="card" style="display:block;padding:8px;border:1px solid #767676">${inner}</div>`)] };
    case 'component-slot': return { html: `<notice-panel>${inner}</notice-panel>`, init: [define('notice-panel', '<div part="panel" style="display:block;overflow:hidden;padding:8px"><slot></slot></div>')] };
    case 'contents-wrapper': return { html: `<div class="media-group" style="display:contents;overflow:hidden">${inner}</div>`, init: [] };
    case 'contained-card': return { html: `<div class="card" style="contain:paint;padding:8px;border:1px solid #767676">${inner}</div>`, init: [] };
    case 'cv-section': return { html: `<section class="postings" style="content-visibility:auto;contain-intrinsic-size:auto 400px">${inner}</section>`, init: [] };
    case 'inline-link': return { html: `<p><a href="/notices/latest" style="overflow:hidden">${inner}</a></p>`, init: [] };
    case 'component-closed-panel': return { html: `<notice-disclosure>${inner}</notice-disclosure>`, init: [define('notice-disclosure', '<p part="summary">More about this posting</p><div part="panel" style="height:0;overflow:hidden"><slot></slot></div>')] };
    case 'component-reveal': return { html: '<notice-reveal></notice-reveal>', init: [define('notice-reveal', inner, "this.style.display = 'block'; this.style.clipPath = 'inset(0 0 100% 0)'; ")] };
    case 'reveal-wrapper': return { html: `<div class="reveal" style="clip-path:inset(0 0 100% 0)">${inner}</div>`, init: [] };
    case 'component-teaser': return { html: `<notice-teaser>${inner}</notice-teaser>`, init: [define('notice-teaser', '<div part="panel" style="max-height:80px;overflow:hidden"><slot></slot></div>')] };
  }
}

/** A notice whose last line runs past the right edge of the file's own drawing: part of its words are cut off. */
function pastEdgeSvg(lines: readonly string[]): Drawn {
  return { svg: svgFile(640, 160, `<rect width="640" height="160" fill="#f4efe2"/>${G(`<text x="36" y="60" font-size="28" font-weight="700">${esc(lines[0]!)}</text><text x="36" y="112" font-size="22">${esc(lines.slice(1).join(' '))}</text>`)}`), w: 640, h: 160 };
}

// ---- The full-tree review's cut round ----------------------------------------------------------------

/**
 * Notices said at length and their equivalent said briefly (the full-tree review's S1): a short alternative or
 * caption that gives what three wordy sentences say. A word count can choose such a picture for a person to check;
 * it cannot show that anything is missing.
 */
const SAID_BRIEFLY: readonly { lines: readonly string[]; brief: string }[] = [
  { lines: ['The service counter at the front of the building is not open to the public on Saturday.', 'The service counter at the front of the building is not open to the public on Sunday.', 'The service counter opens again for all visitors on Monday morning at the usual time.'], brief: 'Counter closed weekends; reopens Monday.' },
  { lines: ['All of the swimming lanes in the indoor pool will be closed to every swimmer this week.', 'All of the swimming lanes in the outdoor pool will be closed to every swimmer this week.', 'Both of the pools will welcome all of the swimmers back again at the start of next week.'], brief: 'Both pools shut until Monday.' },
  { lines: ['Every one of the parking spaces along the north side of the street is reserved for the fair.', 'Every one of the parking spaces along the south side of the street is reserved for the fair.', 'Drivers who leave a car in any of these spaces during the fair will have it towed away.'], brief: 'No parking on either side during the fair; cars are towed.' },
  { lines: ['The library on Main Street is closing early at four in the afternoon on this coming Thursday.', 'The library on Main Street is closing early at four in the afternoon on this coming Friday.', 'The library on Main Street will open at its normal hours again from Saturday morning.'], brief: 'Library shuts at 4 Thursday and Friday.' },
  { lines: ['Please do not leave any bags of garden waste next to the green bins on the curb this month.', 'Please do not leave any bags of garden waste next to the blue bins on the curb this month.', 'Bags of garden waste are collected only at the recycling depot on Mill Road this month.'], brief: 'Take bagged yard waste to the Mill Road depot.' },
  { lines: ['The water in the taps in the east part of town may look a little cloudy for a few hours today.', 'The water in the taps in the west part of town may look a little cloudy for a few hours today.', 'The water is safe to drink, and running the cold tap for a minute will clear it.'], brief: 'Cloudy tap water today is safe; run the cold tap.' },
];
/** A notice said at length: three long lines on a plain ground. */
function wordySvg(lines: readonly string[], r: () => number): Drawn {
  const [bg, fg] = pick(r, GROUNDS);
  return { svg: svgFile(1000, 200, `<rect width="1000" height="200" fill="${bg}"/><g font-family="Arial, Helvetica, sans-serif" fill="${fg}">${lines.map((l, i) => `<text x="30" y="${50 + i * 50}" font-size="18">${esc(l)}</text>`).join('')}</g>`), w: 1000, h: 200 };
}
/** A brand mark: the name, a motto and a line of places, three lines on a dark band. */
const BRAND_MARK = svgFile(480, 130, '<rect width="480" height="130" fill="#12395b"/><g font-family="Georgia, serif" fill="#ffffff"><text x="20" y="40" font-size="26">Birch Valley Water District</text><text x="20" y="75" font-size="16">Clean water for the whole valley since 1952</text><text x="20" y="105" font-size="14">Serving Alder Draw, Fern Lane and Willow Quay</text></g>');
/** A 100% stacked bar: two touching segments of one width, each with its label inside (the review's S3). */
function stackedSvg(r: () => number): Drawn {
  const a = 40 + Math.floor(r() * 40);
  const split = Math.round(20 + 220 * (a / 100));
  return {
    svg: svgFile(640, 260, `<rect width="640" height="260" fill="#ffffff"/><rect x="40" y="20" width="420" height="${split - 20}" fill="#cfe3f1"/><rect x="40" y="${split}" width="420" height="${240 - split}" fill="#f6d7a7"/>${G(`<text x="56" y="${Math.round((20 + split) / 2) + 8}" font-size="20">Renewable sources ${a} percent</text><text x="56" y="${Math.round((split + 240) / 2) + 8}" font-size="20">Fossil fuels ${100 - a} percent</text>`)}`),
    w: 640, h: 260,
  };
}

// ---- Cases ------------------------------------------------------------------------------------------

type Given = 'none' | 'paragraph' | 'terms' | 'table' | 'details' | 'described' | 'caption';
/** The page's text that gives the picture's words (or does not), as markup after the picture; `attr` goes on the picture. */
function givenText(how: Given, lines: readonly string[]): { html: string; attr: string } {
  const all = lines.join('. ').replace(/\.\./g, '.');
  switch (how) {
    case 'none': return { html: '', attr: '' };
    case 'paragraph': return { html: `<p>${esc(all)}</p>`, attr: '' };
    case 'terms': return { html: `<dl>${lines.map((l, i) => (i % 2 === 0 ? `<dt>${esc(l)}</dt>` : `<dd>${esc(l)}</dd>`)).join('')}</dl>`, attr: '' };
    case 'table': return { html: `<table><caption>Details</caption><tbody>${lines.map((l) => `<tr><td>${esc(l)}</td></tr>`).join('')}</tbody></table>`, attr: '' };
    case 'details': return { html: `<details><summary>What the picture says</summary>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}</details>`, attr: '' };
    case 'described': return { html: `<p id="said" hidden>${esc(all)}</p>`, attr: ' aria-describedby="said"' };
    case 'caption': return { html: `<p class="caption">${esc(all)}</p>`, attr: '' };
  }
}

interface Built { body: string; css: string[]; files: Record<string, string | Uint8Array>; init?: string[] }
/**
 * A posting page: an opening paragraph, then the picture under a heading of its own at the end of the content, and
 * the site's footer (set apart from the content) with the page's other text. All of that text is unrelated to
 * every picture. No sentence stands in the picture's section of the page unless the case puts one there
 * (`built.body`): a sentence there may restate the picture in words no comparison can match, which the test
 * leaves open.
 */
function page(id: string, test: string, hazard: Hazard, built: Built, expect: SimCase['expect'], why: string, params: SimCase['params'], r: () => number): SimCase {
  const pg = parts('Notices and announcements', `<p>${UNRELATED[0]}</p><h2>Latest postings</h2>${built.body}`, ['img { max-width: 100%; } table { border-collapse: collapse; } td { border: 1px solid #767676; padding: 4px 8px; } details { margin: 8px 0; } footer.site { padding: 0 24px; }', ...built.css], [...(built.init ?? [])]);
  pg.after.push(`<footer class="site"><h2>Archive</h2><p>${UNRELATED[1]}</p><p>${UNRELATED[2]}</p></footer>`);
  Object.assign(pg.files, built.files);
  applyHazard(pg, hazard, r);
  return { id, test, hazard, params, site: render(pg), expect, why };
}

/**
 * The same thing said another way (the review's S1): six notices, each restated in other words (synonyms, nothing
 * of the notice's wording), with its date and time written another way, and in Spanish.
 */
const SAID: readonly { notice: number; synonyms: string; dates: string; spanish: string }[] = [
  { notice: 0, synonyms: 'Annual portraits will be taken again in the band hall on the nineteenth, mid-morning. Remember the form with a parent signature.', dates: 'Yearbook photo retakes: Tue 5/19, 9:00–11:00 in the music room (east wing). Bring the signed retake slip.', spanish: 'Repetición de fotos del anuario: martes 19 de mayo, de 9 a 11 de la mañana, sala de música, ala este. Traiga la hoja firmada.' },
  { notice: 3, synonyms: 'The number fourteen coach takes another way from the eighth; it will not call along Fern, so wait at the corner by the quay.', dates: 'Route 14 detour from Mon 6/8: buses skip the Fern Street stops; board at Harbor and Third instead.', spanish: 'Desvío de la ruta 14 desde el lunes 8 de junio: los autobuses no paran en la calle Fern; suba en Harbor y Third.' },
  { notice: 6, synonyms: 'Sign up next year’s youngest pupils at the primary school hall, midweek late afternoon; have proof of age and of your address with you.', dates: 'Kindergarten roundup, Wed 3/4, 16:00–18:00, Maple Elementary gymnasium. Bring a birth certificate and a utility bill.', spanish: 'Inscripción de kínder: miércoles 4 de marzo, de 4 a 6 de la tarde, gimnasio de la escuela Maple. Traiga el acta de nacimiento y un recibo de servicios.' },
  { notice: 8, synonyms: 'Volunteers prepare income filings at no charge each weekend morning this month, upstairs; have your previous filing and an identity card.', dates: 'Free tax help on Saturdays in Feb, 9:00–12:00, second floor meeting room. Bring last year’s return and photo ID.', spanish: 'Ayuda gratuita con los impuestos: sábados de febrero, de 9 a 12, sala de reuniones del segundo piso. Traiga la declaración del año pasado y una identificación con foto.' },
  { notice: 18, synonyms: 'Influenza vaccinations are given all afternoon on the eighth at the public health building; dress so your arm is bare and have your coverage details.', dates: 'Flu shot clinic: Thu 10/8, 12:00–18:00, county health annex, room B. Wear short sleeves and bring an insurance card.', spanish: 'Clínica de vacunas contra la gripe: jueves 8 de octubre, de 12 a 6 de la tarde, anexo de salud del condado, sala B. Use manga corta y traiga su tarjeta del seguro.' },
  { notice: 23, synonyms: 'Door-to-door vans do not run on Thanksgiving and run less the day after; reserve your trip well in advance.', dates: 'Paratransit holiday hours: no service Thu 11/26, reduced service Fri; book rides 3 days ahead.', spanish: 'Horario festivo del paratránsito: sin servicio el jueves 26 de noviembre, servicio reducido el viernes. Reserve sus viajes con tres días de antelación.' },
];
const SAID_KINDS = ['synonyms', 'dates', 'spanish'] as const;
/** Each diagram's instruction said in other words, with nothing of its wording. */
const DIAGRAM_SAID = [
  'Motorists continue beyond the mast and may pull up solely where the edging is painted.',
  'Upkeep of the drain between a home and the boundary falls to whoever holds the title.',
  'For now, riders wait at the corner where the two roads meet.',
  'Come in on the sunset side, then go clockwise past the counter to find reserved items.',
  'Settle the total shown in the third panel before its deadline.',
  'No vehicles on the high road along the procession all morning.',
  'Bottles must be taken to the drop-off yard; neither bin accepts them.',
  'Once outside, everyone assembles by the mast near where staff leave their vehicles.',
];
/** A sentence that has nothing to do with the picture, as text right beside it. */
const BESIDE = ['Our gymnasium floor was refinished over the summer break by volunteers.', 'The communications team answers messages within two working days.', 'Printed copies of this page are kept at the reception counter.'];

const hazardAt = (i: number) => HAZARDS[i % HAZARDS.length]!;
const altOf = (lines: readonly string[]) => lines.join('. ').replace(/\.\./g, '.');

/** 1.4.5: notices in every layout and wrapper (fail), pictures that are not images of text (pass), and the uncounted. */
export function blockCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let n = 0;
  // 75 notices: every layout five times, each with another notice, wrapper and hazard; the alt text is complete.
  for (let rep = 0; rep < 5; rep++) {
    for (const [li, layout] of NOTICE_LAYOUTS.entries()) {
      const id = `picture-text-block/notice/${layout}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const lines = NOTICES[(li * 5 + rep * 7) % NOTICES.length]!;
      const wrapper = WRAPPERS[(li + rep * 4) % WRAPPERS.length]!;
      const d = noticeSvg(lines, layout, r);
      const w = wrap(wrapper, d, `alt="${esc(altOf(lines))}"`, r);
      // One or two lines with no sentence end, named word for word by the alt text: a title or a logo cannot be told
      // apart from a notice there (not counted).
      const drawn = layout === 'one-line' ? [lines.slice(1).find((l) => l.split(/\s+/).length >= 5) ?? `${lines[0]}: ${lines[1]}`] : layout === 'wide-banner' ? lines.slice(0, 2) : lines;
      const nameLike = drawn.length <= 2 && !drawn.some((l) => /[.!?]$/.test(l.trim()));
      out.push(page(id, 'picture-text-block', hazardAt(n++), { body: w.html, css: w.css, files: w.files }, { '1.4.5': nameLike ? A : F }, nameLike ? `one or two lines with no sentence end (${layout}), named by the alt text: a title or a logo cannot be told from a notice (not counted)` : `a notice (${layout}) as an SVG picture in ${wrapper} markup: an image of text, whatever its alt text`, { layout, wrapper }, r));
    }
  }
  // 108 look-alikes that pass: four of each kind.
  for (const kind of LOOK_ALIKES_145) {
    for (let rep = 0; rep < 4; rep++) {
      const id = `picture-text-block/${kind}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const o = otherPicture(kind, NOTICES[(rep * 5 + kind.length) % NOTICES.length]!, r);
      const file = '/media/picture.svg';
      out.push(page(id, 'picture-text-block', hazardAt(n++), { body: `<div class="content">${o.html(file)}</div>`, css: [], files: o.svg ? { [file]: o.svg } : {} }, { '1.4.5': P }, `${kind}: not an image of text (a logo, a test, a drawing with labels or with words in its shapes, real text, words never drawn or kept out of sight), or a picture said to be a sample of how something looks`, { kind }, r));
    }
  }
  // Not counted: two of each.
  for (const kind of NOT_COUNTED_145) {
    for (let rep = 0; rep < 2; rep++) {
      const id = `picture-text-block/${kind}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const o = otherPicture(kind, NOTICES[(rep * 3 + kind.length) % NOTICES.length]!, r);
      const file = o.file ? '/media/picture.png' : '/media/picture.svg';
      out.push(page(id, 'picture-text-block', hazardAt(n++), { body: `<div class="content">${o.html(file)}</div>`, css: [], files: o.file ? { [file]: o.file } : o.svg ? { [file]: o.svg } : {} }, { '1.4.5': A }, `${kind}: not counted (needs judgement, or eyes this test does not have)`, { kind }, r));
    }
  }
  // The last fix round (24 failures, 10 not counted): the notice whole in each container the picture test reads as
  // the page is rendered (it fails there as anywhere), and kept out of sight, in all or in part, by one (not counted).
  for (const [ci, where] of SHOWN_IN.entries()) {
    for (let rep = 0; rep < 4; rep++) {
      const id = `picture-text-block/shown-in-${where}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const lines = NOTICES[(ci * 5 + rep * 7 + 2) % NOTICES.length]!;
      const d = noticeSvg(lines, NOTICE_LAYOUTS.filter((l) => l !== 'one-line' && l !== 'wide-banner')[(ci * 2 + rep * 3) % 13]!, r);
      const file = `/media/2026/notice-${ci}-${rep}.svg`;
      const c = drawnIn(where, `<img id="subject" src="${file}" width="${d.w}" height="${d.h}" alt="${esc(altOf(lines))}">`);
      out.push(page(id, 'picture-text-block', hazardAt(n++), { body: c.html, css: [], files: { [file]: d.svg }, init: c.init }, { '1.4.5': F }, `a notice shown whole in ${where}: an image of text, whatever holds it`, { key: `shown-in-${where}` }, r));
    }
  }
  for (const [ci, where] of KEPT_IN.entries()) {
    for (let rep = 0; rep < 2; rep++) {
      const id = `picture-text-block/kept-in-${where}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const lines = NOTICES[(ci * 3 + rep * 11 + 5) % NOTICES.length]!;
      const d = noticeSvg(lines, NOTICE_LAYOUTS.filter((l) => l !== 'one-line' && l !== 'wide-banner')[(ci + rep * 5) % 13]!, r);
      const file = `/media/2026/kept-${ci}-${rep}.svg`;
      const c = drawnIn(where, `<img id="subject" src="${file}" width="${d.w}" height="${d.h}" alt="${esc(altOf(lines))}">`);
      out.push(page(id, 'picture-text-block', hazardAt(n++), { body: c.html, css: [], files: { [file]: d.svg }, init: c.init }, { '1.4.5': A }, `a notice kept out of sight, in all or in part, by ${where} as the page loads: what shows once it is opened is not measured (not counted)`, { key: `kept-in-${where}` }, r));
    }
  }
  for (let rep = 0; rep < 2; rep++) {
    const id = `picture-text-block/past-edge/${rep}`;
    const r = rng(hash(id) ^ seed);
    const lines = NOTICES[(rep * 9 + 4) % NOTICES.length]!;
    const d = pastEdgeSvg(lines);
    out.push(page(id, 'picture-text-block', hazardAt(n++), { body: `<p><img id="subject" src="/media/past-edge.svg" width="${d.w}" height="${d.h}" alt="${esc(altOf(lines))}"></p>`, css: [], files: { '/media/past-edge.svg': d.svg } }, { '1.4.5': A }, 'a notice whose last line runs past the edge of the file: part of its words are cut off (not counted)', { key: 'past-edge' }, r));
  }
  // The cut round (Sol's full-tree review), 12 passes and 4 not counted: a brand mark with three lines drawn in a
  // web component inside a home link (S2: the logo guard reads where it is drawn), a 100% stacked bar with its labels
  // inside (S3), a notice whose padding leaves its image no room (S4); a strip of a notice left by a legacy clip, and
  // a notice in a rounded container that cuts its corners (S4, not counted: what shows of it is not worked out).
  for (const kind of ['shadow-brand', 'stacked-bar', 'padded-away'] as const) {
    for (let rep = 0; rep < 4; rep++) {
      const id = `picture-text-block/cut-${kind}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const lines = NOTICES[(rep * 5 + kind.length) % NOTICES.length]!;
      const d = kind === 'padded-away' ? noticeSvg(lines, 'left-card', r) : kind === 'stacked-bar' ? stackedSvg(r) : { svg: BRAND_MARK, w: 480, h: 130 };
      const file = `/media/2026/${kind}-${rep}.svg`;
      const built: Built = kind === 'shadow-brand'
        ? { body: '<p><a href="/"><site-identity></site-identity></a></p>', css: [], files: { [file]: d.svg }, init: [`if (!customElements.get('site-identity')) customElements.define('site-identity', class extends HTMLElement { connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(`<img id="subject" src="${file}" alt="Birch Valley Water District" width="480" height="130">`)}; } });`] }
        : kind === 'stacked-bar'
          ? { body: `<p><img id="subject" src="${file}" width="640" height="260" alt="Energy mix this year"></p>`, css: [], files: { [file]: d.svg } }
          : { body: `<p><img id="subject" src="${file}" width="${d.w}" height="${d.h}" alt="${esc(altOf(lines))}" style="box-sizing:border-box;padding:${Math.ceil(d.h / 2)}px ${Math.ceil(d.w / 2)}px"></p>`, css: [], files: { [file]: d.svg } };
      out.push(page(id, 'picture-text-block', hazardAt(n++), built, { '1.4.5': P }, kind === 'shadow-brand' ? 'a brand mark of three lines in a web component inside a link to the home page: a logo' : kind === 'stacked-bar' ? 'a 100% stacked bar with its labels inside its two segments: a chart, not a picture of text' : 'a notice whose padding leaves its image no room: nothing of it is painted', { key: `cut-${kind}` }, r));
    }
  }
  for (const kind of ['clip-strip', 'rounded-crop'] as const) {
    for (let rep = 0; rep < 2; rep++) {
      const id = `picture-text-block/cut-${kind}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const lines = NOTICES[(rep * 7 + kind.length) % NOTICES.length]!;
      const d = noticeSvg(lines, 'left-plain', r);
      const file = `/media/2026/${kind}-${rep}.svg`;
      const body = kind === 'clip-strip'
        ? `<div style="position:relative;height:${d.h}px"><img id="subject" src="${file}" width="${d.w}" height="${d.h}" alt="${esc(altOf(lines))}" style="position:absolute;clip:rect(0px,${d.w}px,${Math.round(d.h / 3)}px,0px)"></div>`
        : `<div style="width:${d.w}px;border-radius:${Math.round(d.h / 2)}px;overflow:hidden"><img id="subject" src="${file}" width="${d.w}" height="${d.h}" alt="${esc(altOf(lines))}" style="display:block"></div>`;
      out.push(page(id, 'picture-text-block', hazardAt(n++), { body, css: [], files: { [file]: d.svg } }, { '1.4.5': A }, `a notice of which a ${kind === 'clip-strip' ? 'legacy clip shows a strip' : 'rounded container cuts the corners'}: what shows of it is not worked out (not counted)`, { key: `cut-${kind}` }, r));
    }
  }
  return out;
}

const WRONG_ALTS = ['Students reading in the school library.', 'A crowd at the spring fair', 'Staff at the front counter', 'Volunteers painting a fence'];
const KIND_ALTS = ['Flyer', 'Notice', 'Poster', 'Image', 'Graphic', 'Banner', 'Schedule', 'Sign'];
const FILE_ALTS = ['notice-final.svg', 'flyer_v2.svg', 'IMG_2041.svg', 'board-notice.svg', 'untitled-1.svg', 'export.svg'];

/** 1.1.1, the block rule: a notice whose alternative gives none of its words (fail), and the same given somewhere (pass). */
export function altCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let n = 0;
  // 72 failures: wrong, kind-only and file-name alternatives, and a title-only one, across layouts and wrappers.
  const bad = [...WRONG_ALTS.map((a) => ['wrong', a] as const), ...KIND_ALTS.slice(0, 4).map((a) => ['kind', a] as const), ...FILE_ALTS.slice(0, 3).map((a) => ['file', a] as const), ['title', ''] as const];
  for (let rep = 0; rep < 6; rep++) {
    for (const [bi, [mode, alt]] of bad.entries()) {
      const id = `picture-text-alt/${mode}-${bi}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const lines = NOTICES[(bi * 3 + rep * 5) % NOTICES.length]!;
      const layout = NOTICE_LAYOUTS.filter((l) => l !== 'one-line' && l !== 'wide-banner')[(bi + rep * 3) % 13]!;
      const wrapper = WRAPPERS[(bi * 2 + rep) % WRAPPERS.length]!;
      const d = noticeSvg(lines, layout, r);
      const w = wrap(wrapper, d, `alt="${esc(mode === 'title' ? lines[0]! : alt)}"`, r);
      out.push(page(id, 'picture-text-alt', hazardAt(n++), { body: w.html, css: w.css, files: w.files }, { '1.1.1': F }, `a notice whose alternative (${mode}) gives none of its date, place and instruction, on a page that does not either`, { mode, layout, wrapper }, r));
    }
  }
  // 72 passes: a complete alternative (18), the words in the page's text in six ways with a kind-only or wrong-free
  // alternative (36), a link to a text version (6), inside a link (6), a logo (6).
  const pass = (key: string, rep: number, make: (lines: readonly string[], d: Drawn, r: () => number) => Built, why: string) => {
    const id = `picture-text-alt/${key}/${rep}`;
    const r = rng(hash(id) ^ seed);
    const lines = NOTICES[(rep * 7 + key.length * 3) % NOTICES.length]!;
    const d = noticeSvg(lines, NOTICE_LAYOUTS.filter((l) => l !== 'one-line' && l !== 'wide-banner')[(rep + key.length) % 13]!, r);
    out.push(page(id, 'picture-text-alt', hazardAt(n++), make(lines, d, r), { '1.1.1': P }, why, { key }, r));
  };
  for (let rep = 0; rep < 18; rep++) {
    pass('complete', rep, (lines, d, r) => { const w = wrap(WRAPPERS[rep % WRAPPERS.length]!, d, `alt="${esc(altOf(lines))}"`, r); return { body: w.html, css: w.css, files: w.files }; }, 'the alternative gives every line of the notice (G94)');
  }
  for (const how of ['paragraph', 'terms', 'table', 'details', 'described', 'caption'] as const) {
    for (let rep = 0; rep < 6; rep++) {
      pass(`given-${how}`, rep, (lines, d, r) => {
        const g = givenText(how, lines);
        const w = wrap(WRAPPERS[(rep * 2) % WRAPPERS.length]!, d, `alt="${esc(KIND_ALTS[rep % KIND_ALTS.length]!)}"${g.attr}`, r);
        return { body: `${w.html}${g.html}`, css: w.css, files: w.files };
      }, `a short alternative that names the kind, with the notice's words in the page's text (${how}): G74`);
    }
  }
  for (let rep = 0; rep < 6; rep++) {
    pass('text-version', rep, (_lines, d, r) => { const w = wrap('plain', d, `alt="${esc(KIND_ALTS[rep % KIND_ALTS.length]!)}"`, r); return { body: `<figure>${w.html}<p><a href="/notices/text">Text version of this notice</a></p></figure>`, css: w.css, files: w.files }; }, 'a link next to the picture offers its text (G73)');
    pass('in-link', rep, (lines, d, r) => { const w = wrap('plain', d, `alt="${esc(lines[0]!)}: read the notice"`, r); return { body: `<a href="/notices/latest">${w.html.replace(/^<p>|<\/p>$/g, '')}</a>`, css: w.css, files: w.files }; }, 'the picture is a link: its alternative names where the link goes');
    pass('logo', rep, (_lines, _d, r) => { const o = otherPicture(rep % 2 ? 'logo-class' : 'logo-alt', NOTICES[0]!, r); return { body: o.html('/media/logo.svg'), css: [], files: { '/media/logo.svg': o.svg } }; }, 'a logo: its words are its name');
  }
  // 72 passes, the review's S1: an alternative of about the notice's length that says the same in other words
  // (synonyms only), with the date and time written another way, or in Spanish. Words that do not match never
  // show that such an alternative is missing.
  for (const [si, said] of SAID.entries()) {
    for (const kind of SAID_KINDS) {
      for (let rep = 0; rep < 4; rep++) {
        const id = `picture-text-alt/said-${kind}-${si}/${rep}`;
        const r = rng(hash(id) ^ seed);
        const lines = NOTICES[said.notice]!;
        const d = noticeSvg(lines, NOTICE_LAYOUTS.filter((l) => l !== 'one-line' && l !== 'wide-banner')[(si * 2 + rep * 3) % 13]!, r);
        const w = wrap(WRAPPERS[(si + rep * 4 + kind.length) % WRAPPERS.length]!, d, `alt="${esc(said[kind])}"`, r);
        out.push(page(id, 'picture-text-alt', hazardAt(n++), { body: w.html, css: w.css, files: w.files }, { '1.1.1': P }, `the alternative gives the notice ${kind === 'synonyms' ? 'in other words' : kind === 'dates' ? 'with its date and time written another way' : 'in Spanish'}: an equivalent, whatever words it shares`, { key: `said-${kind}` }, r));
      }
    }
  }
  // Not counted: a short alternative with an unrelated sentence right beside the notice (a failure, but a sentence
  // beside a picture may restate it in words this test cannot match, so it is left open).
  for (let rep = 0; rep < 6; rep++) {
    const id = `picture-text-alt/beside-unrelated/${rep}`;
    const r = rng(hash(id) ^ seed);
    const lines = NOTICES[(rep * 5 + 1) % NOTICES.length]!;
    const w = wrap('plain', noticeSvg(lines, 'left-card', r), `alt="${esc(KIND_ALTS[rep % KIND_ALTS.length]!)}"`, r);
    out.push(page(id, 'picture-text-alt', hazardAt(n++), { body: `${w.html}<p>${BESIDE[rep % BESIDE.length]}</p>`, css: w.css, files: w.files }, { '1.1.1': A }, 'a kind-only alternative with an unrelated sentence right beside the notice: whether the sentence restates it is a judgement (not counted)', { key: 'beside-unrelated' }, r));
  }
  // Not counted: no alt attribute (axe's failure), and a wrong alternative on a page that gives the words.
  for (let rep = 0; rep < 4; rep++) {
    const id = `picture-text-alt/no-alt/${rep}`;
    const r = rng(hash(id) ^ seed);
    const lines = NOTICES[(rep * 11) % NOTICES.length]!;
    const w = wrap(WRAPPERS[rep % WRAPPERS.length]!, noticeSvg(lines, 'left-card', r), '', r);
    out.push(page(id, 'picture-text-alt', hazardAt(n++), { body: w.html, css: w.css, files: w.files }, { '1.1.1': A }, 'no alt attribute at all: the missing-alt rule fails it, not this test', { key: 'no-alt' }, r));
    const id2 = `picture-text-alt/wrong-but-given/${rep}`;
    const r2 = rng(hash(id2) ^ seed);
    const w2 = wrap('plain', noticeSvg(lines, 'left-plain', r2), `alt="${esc(WRONG_ALTS[rep % WRONG_ALTS.length]!)}"`, r2);
    out.push(page(id2, 'picture-text-alt', hazardAt(n++), { body: `${w2.html}${givenText('paragraph', lines).html}`, css: w2.css, files: w2.files }, { '1.1.1': A }, 'the alternative says something else, but the page gives the words: whether that is a failure is a judgement', { key: 'wrong-but-given' }, r2));
  }
  // The last fix round (15 failures): a notice with a wrong alternative, shown whole in a container the picture test
  // reads as the page is rendered (a link names its target, so the inline link is left out here).
  for (const [ci, where] of SHOWN_IN.filter((x) => x !== 'inline-link').entries()) {
    for (let rep = 0; rep < 3; rep++) {
      const id = `picture-text-alt/shown-in-${where}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const lines = NOTICES[(ci * 4 + rep * 9 + 1) % NOTICES.length]!;
      const d = noticeSvg(lines, NOTICE_LAYOUTS.filter((l) => l !== 'one-line' && l !== 'wide-banner')[(ci * 3 + rep) % 13]!, r);
      const file = `/media/2026/notice-${ci}-${rep}.svg`;
      const c = drawnIn(where, `<img id="subject" src="${file}" width="${d.w}" height="${d.h}" alt="${esc(WRONG_ALTS[(ci + rep) % WRONG_ALTS.length]!)}">`);
      out.push(page(id, 'picture-text-alt', hazardAt(n++), { body: c.html, css: [], files: { [file]: d.svg }, init: c.init }, { '1.1.1': F }, `a notice shown whole in ${where}, whose alternative gives none of its words, on a page that does not either`, { key: `shown-in-${where}` }, r));
    }
  }
  // The cut round (Sol's full-tree review, S1), 12 passes: a notice said at length whose short alternative says it
  // briefly. A third of the words or fewer is no proof that anything is missing.
  for (const [bi, b] of SAID_BRIEFLY.entries()) {
    for (let rep = 0; rep < 2; rep++) {
      const id = `picture-text-alt/said-briefly-${bi}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const d = wordySvg(b.lines, r);
      const w = wrap(WRAPPERS[(bi * 2 + rep) % WRAPPERS.length]!, d, `alt="${esc(b.brief)}"`, r);
      out.push(page(id, 'picture-text-alt', hazardAt(n++), { body: w.html, css: w.css, files: w.files }, { '1.1.1': P }, 'a notice said at length whose short alternative says the same briefly (G94)', { key: 'said-briefly' }, r));
    }
  }
  return out;
}

const HIDDEN_HOW = ['alt-empty', 'role-presentation', 'aria-hidden', 'role-none', 'hidden-wrapper'] as const;
const hiddenAttrs = (how: (typeof HIDDEN_HOW)[number], alt: string) => (how === 'alt-empty' ? 'alt=""' : how === 'role-presentation' ? `alt="${esc(alt)}" role="presentation"` : how === 'role-none' ? `alt="${esc(alt)}" role="none"` : how === 'aria-hidden' ? `alt="${esc(alt)}" aria-hidden="true"` : 'alt=""');

/** 1.1.1, the hidden rule: a picture kept from screen readers that draws an instruction (fail), and decoration (pass). */
export function hiddenCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let n = 0;
  // 40 diagrams and 30 notices, hidden in five ways.
  for (let rep = 0; rep < 14; rep++) {
    for (const [hi, how] of HIDDEN_HOW.entries()) {
      const id = `picture-text-hidden/${how}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const notice = rep >= 8;
      const d0 = DIAGRAMS[(rep + hi) % DIAGRAMS.length]!;
      const lines = NOTICES[(rep * 3 + hi) % NOTICES.length]!;
      const d = notice ? noticeSvg(lines, NOTICE_LAYOUTS[(rep + hi) % NOTICE_LAYOUTS.length]!, r) : diagramSvg(d0, r);
      // aria-hidden on a wrapper counts within three levels of the picture: the short wrappers only.
      const near = ['plain', 'picture', 'narrow-column', 'lazy-sized', 'srcset'] as const;
      const w = wrap(how === 'hidden-wrapper' ? near[rep % near.length]! : WRAPPERS[(rep + hi * 3) % WRAPPERS.length]!, d, hiddenAttrs(how, notice ? lines[0]! : d0.title), r);
      const body = how === 'hidden-wrapper' ? `<div aria-hidden="true">${w.html}</div>` : w.html;
      out.push(page(id, 'picture-text-hidden', hazardAt(n++), { body, css: w.css, files: w.files }, { '1.1.1': F }, `a ${notice ? 'notice' : 'diagram with an instruction'} kept from screen readers (${how}), whose words are nowhere in the page's text`, { how, notice }, r));
    }
  }
  // 72 passes: the same pictures with the words beside them (six ways, 36), decoration with labels only (12), a
  // short sign in an illustration (12), words never drawn (6), a wordless flourish (6).
  let k = 0;
  for (const how of ['paragraph', 'terms', 'table', 'details', 'described', 'caption'] as const) {
    for (let rep = 0; rep < 6; rep++) {
      const id = `picture-text-hidden/given-${how}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const d0 = DIAGRAMS[(rep + k) % DIAGRAMS.length]!;
      const d = diagramSvg(d0, r);
      const g = givenText(how, [...d0.labels, d0.says]);
      const w = wrap(WRAPPERS[(rep + k) % WRAPPERS.length]!, d, `alt=""${g.attr}`, r);
      out.push(page(id, 'picture-text-hidden', hazardAt(n++), { body: `${w.html}${g.html}`, css: w.css, files: w.files }, { '1.1.1': P }, `the diagram only repeats the text beside it (${how}): an empty alternative is right (H67)`, { how }, r));
      k++;
    }
  }
  for (let rep = 0; rep < 12; rep++) {
    const id = `picture-text-hidden/labels-only/${rep}`;
    const r = rng(hash(id) ^ seed);
    const d = diagramSvg(DIAGRAMS[rep % DIAGRAMS.length]!, r, { says: false });
    const w = wrap(WRAPPERS[rep % WRAPPERS.length]!, d, 'alt=""', r);
    out.push(page(id, 'picture-text-hidden', hazardAt(n++), { body: w.html, css: w.css, files: w.files }, { '1.1.1': A }, 'a drawing with two labels and no instruction, marked decorative: whether the labels matter is a judgement (not counted)', { key: 'labels-only' }, r));
    const id2 = `picture-text-hidden/sign/${rep}`;
    const r2 = rng(hash(id2) ^ seed);
    const sign = svgFile(640, 280, `<rect width="640" height="280" fill="#d8e4d9"/><rect x="60" y="80" width="360" height="170" fill="#e7cfaa"/><rect x="200" y="110" width="96" height="140" fill="#305e5d"/><path d="M40 80 L240 20 L440 80 Z" fill="#255755"/><circle cx="540" cy="70" r="36" fill="#f1d58a"/>${G(TEXT(100, 104, 'WELCOME BACK'))}`);
    out.push(page(id2, 'picture-text-hidden', hazardAt(n++), { body: `<p><img id="subject" src="/media/scene.svg" width="640" height="280" alt=""></p>`, css: [], files: { '/media/scene.svg': sign } }, { '1.1.1': P }, 'an illustration with a two-word sign, marked decorative beside the page\'s own text', { key: 'sign' }, r2));
  }
  for (let rep = 0; rep < 6; rep++) {
    for (const kind of ['words-not-drawn', 'flourish'] as const) {
      const id = `picture-text-hidden/${kind}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const o = kind === 'words-not-drawn' ? otherPicture('words-not-drawn', NOTICES[rep % NOTICES.length]!, r) : { svg: svgFile(640, 60, '<path d="M20 30 C 160 0, 480 60, 620 30" fill="none" stroke="#2f4f3a" stroke-width="5"/><circle cx="320" cy="30" r="8" fill="#2f4f3a"/>'), w: 640, h: 60, html: (src: string) => `<img id="subject" src="${src}" width="640" height="60" alt="">` };
      out.push(page(id, 'picture-text-hidden', hazardAt(n++), { body: `<p>${o.html('/media/divider.svg')}</p>`, css: [], files: { '/media/divider.svg': o.svg } }, { '1.1.1': P }, `${kind}: nothing the picture shows is missing from the page`, { key: kind }, r));
    }
  }
  // 36 passes, the review's S1 beside the picture: a notice marked decorative whose words the paragraph after or
  // before its markup gives in other words (synonyms only), with the date written another way, or in Spanish. The
  // wrappers put a caption, a control's name, a table cell or a media article between the two.
  for (const [si, said] of SAID.entries()) {
    for (const kind of SAID_KINDS) {
      for (let rep = 0; rep < 2; rep++) {
        const id = `picture-text-hidden/said-beside-${kind}-${si}/${rep}`;
        const r = rng(hash(id) ^ seed);
        const d = noticeSvg(NOTICES[said.notice]!, NOTICE_LAYOUTS[(si + rep * 5 + kind.length) % NOTICE_LAYOUTS.length]!, r);
        const w = wrap(WRAPPERS[(si * 3 + rep + kind.length) % WRAPPERS.length]!, d, 'alt=""', r);
        const beside = rep === 0 ? `${w.html}<p>${esc(said[kind])}</p>` : `<p>${esc(said[kind])}</p>${w.html}`;
        out.push(page(id, 'picture-text-hidden', hazardAt(n++), { body: beside, css: w.css, files: w.files }, { '1.1.1': P }, `the notice only repeats the paragraph ${rep === 0 ? 'after' : 'before'} it, which says the same ${kind === 'synonyms' ? 'in other words' : kind === 'dates' ? 'with the date written another way' : 'in Spanish'}: an empty alternative is right`, { key: `said-beside-${kind}` }, r));
      }
    }
  }
  // Not counted: a notice marked decorative with part of its words covered by a shape of the ground's colour.
  for (let rep = 0; rep < 4; rep++) {
    const id = `picture-text-hidden/half-covered/${rep}`;
    const r = rng(hash(id) ^ seed);
    const d = noticeSvg(NOTICES[(rep * 7 + 3) % NOTICES.length]!, 'left-plain', r);
    const covered = { ...d, svg: d.svg.replace(/<\/svg>$/, `<rect x="0" y="${Math.round(d.h * 0.42)}" width="${d.w}" height="12" fill="${/<rect width="\d+" height="\d+" fill="([^"]+)"/.exec(d.svg)?.[1] ?? '#ffffff'}"/></svg>`) };
    const w = wrap('plain', covered, 'alt=""', r);
    out.push(page(id, 'picture-text-hidden', hazardAt(n++), { body: w.html, css: w.css, files: w.files }, { '1.1.1': A }, 'a notice with a band of the ground\'s colour over part of its words: which words still show is a judgement (not counted)', { key: 'half-covered' }, r));
  }
  // The last fix round (15 failures, 4 not counted): a diagram with an instruction, marked decorative, shown whole in
  // a container the picture test reads as the page is rendered; and kept out of sight by one (not counted).
  for (const [ci, where] of SHOWN_IN.filter((x) => x !== 'inline-link').entries()) {
    for (let rep = 0; rep < 3; rep++) {
      const id = `picture-text-hidden/shown-in-${where}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const d0 = DIAGRAMS[(ci * 3 + rep) % DIAGRAMS.length]!;
      const d = diagramSvg(d0, r);
      const file = `/media/2026/diagram-${ci}-${rep}.svg`;
      const c = drawnIn(where, `<img id="subject" src="${file}" width="${d.w}" height="${d.h}" alt="">`);
      out.push(page(id, 'picture-text-hidden', hazardAt(n++), { body: c.html, css: [], files: { [file]: d.svg }, init: c.init }, { '1.1.1': F }, `a diagram with an instruction, marked decorative and shown whole in ${where}, whose words are nowhere in the page's text`, { key: `shown-in-${where}` }, r));
    }
  }
  for (const where of ['component-closed-panel', 'reveal-wrapper'] as const) {
    for (let rep = 0; rep < 2; rep++) {
      const id = `picture-text-hidden/kept-in-${where}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const d = diagramSvg(DIAGRAMS[(rep * 5 + where.length) % DIAGRAMS.length]!, r);
      const file = `/media/2026/kept-${rep}.svg`;
      const c = drawnIn(where, `<img id="subject" src="${file}" width="${d.w}" height="${d.h}" alt="">`);
      out.push(page(id, 'picture-text-hidden', hazardAt(n++), { body: c.html, css: [], files: { [file]: d.svg }, init: c.init }, { '1.1.1': A }, `a diagram marked decorative and kept out of sight by ${where} as the page loads: what shows once it is opened is not measured (not counted)`, { key: `kept-in-${where}` }, r));
    }
  }
  // The cut round (Sol's full-tree review, S1), 6 passes: a notice said at length, marked decorative, in a figure
  // whose caption says it briefly.
  for (const [bi, b] of SAID_BRIEFLY.entries()) {
    const id = `picture-text-hidden/said-briefly-caption-${bi}/0`;
    const r = rng(hash(id) ^ seed);
    const d = wordySvg(b.lines, r);
    const file = `/media/2026/wordy-${bi}.svg`;
    out.push(page(id, 'picture-text-hidden', hazardAt(n++), { body: `<figure><img id="subject" src="${file}" width="${d.w}" height="${d.h}" alt=""><figcaption>${esc(b.brief)}</figcaption></figure>`, css: [], files: { [file]: d.svg } }, { '1.1.1': P }, 'a notice said at length, marked decorative, whose figure caption says it briefly: an empty alternative is right (H67)', { key: 'said-briefly-caption' }, r));
  }
  return out;
}

/** 1.1.1, the kind rule: a diagram with an instruction named only by its kind or a file name (fail); described (pass). */
export function kindCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let n = 0;
  // 72 failures: each diagram with its kind word, a kind phrase, and three file names, in the wrappers.
  const alts = (d: (typeof DIAGRAMS)[number]) => [d.kind, `Image of a ${d.kind.toLowerCase()}`, `The ${d.kind.toLowerCase()}`, `${d.file}.svg`, `${d.file}-final-v2.svg`, 'IMG_0412.svg', `${d.kind} 2`, 'Graphic', 'Picture'];
  for (const [di, d0] of DIAGRAMS.entries()) {
    for (const [ai, alt] of alts(d0).entries()) {
      const id = `picture-text-kind/${d0.file}/${ai}`;
      const r = rng(hash(id) ^ seed);
      const d = diagramSvg(d0, r);
      const w = wrap(WRAPPERS[(di * 2 + ai) % WRAPPERS.length]!, d, `alt="${esc(alt)}"`, r);
      out.push(page(id, 'picture-text-kind', hazardAt(n++), { body: w.html, css: w.css, files: w.files }, { '1.1.1': F }, `a diagram whose alternative ("${alt}") names only its kind or its file, and whose instruction is nowhere in the page's text (F30)`, { alt }, r));
    }
  }
  // 72 passes: the kind word with a long description (six ways, 48), a link to a text version (8), an alternative
  // that gives the instruction (16).
  let k = 0;
  for (const how of ['paragraph', 'terms', 'table', 'details', 'described', 'caption'] as const) {
    for (let rep = 0; rep < 8; rep++) {
      const id = `picture-text-kind/given-${how}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const d0 = DIAGRAMS[(rep + k) % DIAGRAMS.length]!;
      const g = givenText(how, [...d0.labels, d0.says]);
      const w = wrap(WRAPPERS[(rep * 2 + k) % WRAPPERS.length]!, diagramSvg(d0, r), `alt="${esc(rep % 2 ? d0.kind : `${d0.file}.svg`)}"${g.attr}`, r);
      const counted = rep % 2 === 1;
      out.push(page(id, 'picture-text-kind', hazardAt(n++), { body: `${w.html}${g.html}`, css: w.css, files: w.files }, { '1.1.1': counted ? P : A }, counted ? `"${d0.kind}" with the diagram's long description in the page's text (${how}): G74` : `a file name as the alternative with the description in the page's text (${how}): the names test's question, not counted here`, { how }, r));
      k++;
    }
  }
  for (let rep = 0; rep < 24; rep++) {
    const id = `picture-text-kind/${rep < 8 ? 'text-version' : 'says-it'}/${rep}`;
    const r = rng(hash(id) ^ seed);
    const d0 = DIAGRAMS[rep % DIAGRAMS.length]!;
    const d = diagramSvg(d0, r);
    if (rep < 8) {
      const w = wrap('plain', d, `alt="${esc(d0.kind)}"`, r);
      out.push(page(id, 'picture-text-kind', hazardAt(n++), { body: `<figure>${w.html}<p><a href="/maps/text">Description of this ${d0.kind.toLowerCase()}</a></p></figure>`, css: w.css, files: w.files }, { '1.1.1': P }, 'a link next to the picture offers its description (G73)', { key: 'text-version' }, r));
    } else {
      const w = wrap(WRAPPERS[rep % WRAPPERS.length]!, d, `alt="${esc(`${d0.title}: ${d0.says} ${d0.labels.join(', ')}.`)}"`, r);
      out.push(page(id, 'picture-text-kind', hazardAt(n++), { body: w.html, css: w.css, files: w.files }, { '1.1.1': P }, 'the alternative gives the diagram\'s instruction and labels (G94)', { key: 'says-it' }, r));
    }
  }
  // 16 passes, the review's S1 beside the picture: the kind word, with the instruction said in other words
  // (synonyms only) in the paragraph right after or before the diagram.
  for (let rep = 0; rep < 16; rep++) {
    const id = `picture-text-kind/said-beside/${rep}`;
    const r = rng(hash(id) ^ seed);
    const di = rep % DIAGRAMS.length;
    const d0 = DIAGRAMS[di]!;
    const w = wrap(WRAPPERS[(rep * 2 + 1) % WRAPPERS.length]!, diagramSvg(d0, r), `alt="${esc(d0.kind)}"`, r);
    const said = `<p>${esc(DIAGRAM_SAID[di]!)}</p>`;
    out.push(page(id, 'picture-text-kind', hazardAt(n++), { body: rep < 8 ? `${w.html}${said}` : `${said}${w.html}`, css: w.css, files: w.files }, { '1.1.1': P }, `"${d0.kind}" with the diagram's instruction given in other words in the paragraph ${rep < 8 ? 'after' : 'before'} it: G74`, { key: 'said-beside' }, r));
  }
  // Not counted: an alternative that names the subject and leaves the instruction out.
  for (let rep = 0; rep < 6; rep++) {
    const id = `picture-text-kind/names-subject/${rep}`;
    const r = rng(hash(id) ^ seed);
    const d0 = DIAGRAMS[rep % DIAGRAMS.length]!;
    const w = wrap('plain', diagramSvg(d0, r), `alt="${esc(d0.title)} for visitors"`, r);
    out.push(page(id, 'picture-text-kind', hazardAt(n++), { body: w.html, css: w.css, files: w.files }, { '1.1.1': A }, 'the alternative names the subject and leaves the instruction out: whether that is enough is the AI review\'s (not counted)', { key: 'names-subject' }, r));
  }
  // The last fix round (10 failures): a diagram named by its kind, shown whole in a container the picture test reads
  // as the page is rendered.
  for (const [ci, where] of SHOWN_IN.filter((x) => x !== 'inline-link').entries()) {
    for (let rep = 0; rep < 2; rep++) {
      const id = `picture-text-kind/shown-in-${where}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const d0 = DIAGRAMS[(ci * 2 + rep * 3) % DIAGRAMS.length]!;
      const d = diagramSvg(d0, r);
      const file = `/media/2026/${d0.file}.svg`;
      const c = drawnIn(where, `<img id="subject" src="${file}" width="${d.w}" height="${d.h}" alt="${esc(d0.kind)}">`);
      out.push(page(id, 'picture-text-kind', hazardAt(n++), { body: c.html, css: [], files: { [file]: d.svg }, init: c.init }, { '1.1.1': F }, `a diagram named only "${d0.kind}", shown whole in ${where}, whose instruction is nowhere in the page's text (F30)`, { key: `shown-in-${where}` }, r));
    }
  }
  return out;
}

const BG_HOW = ['contain', 'exact', 'auto-roomy', 'stretched', 'section-contain', 'link-block'] as const;

/** A notice as a CSS background: 1.1.1 (no alternative, F3) and 1.4.5 fail; decoration and named backgrounds differ. */
export function backgroundCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let n = 0;
  const bgBox = (how: (typeof BG_HOW)[number], d: Drawn, file: string, attrs = '', inner = '') => {
    const u = `url(${file})`;
    switch (how) {
      case 'contain': return `<div id="subject" ${attrs} style="height:${d.h}px;background:center / contain no-repeat ${u}">${inner}</div>`;
      case 'exact': return `<div id="subject" ${attrs} style="width:${d.w}px;height:${d.h}px;background-image:${u};background-repeat:no-repeat">${inner}</div>`;
      case 'auto-roomy': return `<div id="subject" ${attrs} style="width:${d.w + 80}px;height:${d.h + 40}px;background:${u} no-repeat left top">${inner}</div>`;
      case 'stretched': return `<div id="subject" ${attrs} style="width:${d.w}px;height:${d.h}px;background:${u} no-repeat;background-size:100% 100%">${inner}</div>`;
      case 'section-contain': return `<section id="subject" ${attrs} class="hero" style="min-height:${d.h}px;background:left / contain no-repeat ${u}">${inner}</section>`;
      case 'link-block': return `<div id="subject" ${attrs} class="tile" style="display:block;width:${d.w}px;height:${d.h}px;background:${u} no-repeat">${inner}</div>`;
    }
  };
  // 72 failures of both criteria.
  for (let rep = 0; rep < 12; rep++) {
    for (const [hi, how] of BG_HOW.entries()) {
      const id = `picture-text-background/${how}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const lines = NOTICES[(rep * 5 + hi * 3) % NOTICES.length]!;
      const d = noticeSvg(lines, NOTICE_LAYOUTS.filter((l) => l !== 'clear-ground')[(rep + hi * 2) % 14]!, r);
      const file = `/themes/site/img/notice-${rep}.svg`;
      out.push(page(id, 'picture-text-background', hazardAt(n++), { body: bgBox(how, d, file), css: [], files: { [file]: d.svg } }, { '1.1.1': F, '1.4.5': F }, `a notice as the CSS background (${how}) of an empty element: no text alternative is possible (F3), and it is an image of text`, { how }, r));
    }
  }
  // Passes of 1.1.1 that still fail 1.4.5 (18): the element's own words, a name, or the next paragraph give the notice.
  for (let rep = 0; rep < 18; rep++) {
    const id = `picture-text-background/named-${rep % 3}/${rep}`;
    const r = rng(hash(id) ^ seed);
    const lines = NOTICES[(rep * 7 + 2) % NOTICES.length]!;
    const d = noticeSvg(lines, NOTICE_LAYOUTS.filter((l) => l !== 'clear-ground')[rep % 14]!, r);
    const file = `/themes/site/img/notice-n${rep}.svg`;
    const how = BG_HOW[rep % 4]!;
    const body = rep % 3 === 0 ? bgBox(how, d, file, '', `<span class="visually-hidden">${esc(altOf(lines))}</span>`)
      : rep % 3 === 1 ? bgBox(how, d, file, `role="img" aria-label="${esc(altOf(lines))}"`)
        : `${bgBox(how, d, file)}<p>${esc(altOf(lines))}</p>`;
    out.push(page(id, 'picture-text-background', hazardAt(n++), { body, css: ['.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }'], files: { [file]: d.svg } }, { '1.1.1': P, '1.4.5': F }, 'the background notice\'s words are given (hidden text in the element, a name, or the next paragraph): 1.1.1 is met, and it is still an image of text', { how }, r));
  }
  // Passes of both (54): decorative patterns and scenes with no words, and a hero whose words are real text over it.
  for (let rep = 0; rep < 54; rep++) {
    const id = `picture-text-background/decor-${rep % 3}/${rep}`;
    const r = rng(hash(id) ^ seed);
    const lines = NOTICES[(rep * 3) % NOTICES.length]!;
    const pattern = svgFile(24, 24, `<circle cx="12" cy="12" r="${2 + (rep % 3)}" fill="#c9d3c4"/>`);
    const scene = svgFile(900, 300, `<rect width="900" height="300" fill="#dfe9f2"/><path d="M0 240 C 200 ${150 + (rep % 5) * 10}, 500 290, 900 200 V300 H0 Z" fill="#7a9e7e"/><circle cx="${700 + (rep % 4) * 20}" cy="80" r="40" fill="#f1d58a"/>`);
    const body = rep % 3 === 0 ? `<div id="subject" class="notices" style="background:#fff url(/img/dots.svg);padding:16px;border:2px solid #595959">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>`
      : rep % 3 === 1 ? `<div id="subject" class="hero" style="height:300px;background:center / cover no-repeat url(/img/scene.svg)"></div><p>${esc(altOf(lines))}</p>`
        : `<div id="subject" class="hero" style="min-height:300px;background:#dfe9f2 center / cover no-repeat url(/img/scene.svg);padding:24px"><h2 style="background:#fff;display:inline-block;padding:4px 12px">${esc(lines[0]!)}</h2><p style="background:#fff;display:inline-block;padding:4px 12px">${esc(lines[1]!)}</p></div>`;
    out.push(page(id, 'picture-text-background', hazardAt(n++), { body, css: [], files: { '/img/dots.svg': pattern, '/img/scene.svg': scene } }, { '1.1.1': P, '1.4.5': P }, 'a decorative background with no words; the words are real text', { key: `decor-${rep % 3}` }, r));
  }
  // Passes of both (24), the review's S5: a background notice that shows none of its words (placed outside the box,
  // or under a layer that covers it), or shows them too small to read (painted 16 px wide).
  const unseen = ['off-box', 'tiny', 'under-layer'] as const;
  for (let rep = 0; rep < 24; rep++) {
    const how = unseen[rep % 3]!;
    const id = `picture-text-background/${how}/${rep}`;
    const r = rng(hash(id) ^ seed);
    const d = noticeSvg(NOTICES[(rep * 5 + 4) % NOTICES.length]!, NOTICE_LAYOUTS.filter((l) => l !== 'clear-ground')[rep % 14]!, r);
    const file = `/themes/site/img/notice-u${rep}.svg`;
    const style = how === 'off-box' ? `background:url(${file}) no-repeat ${d.w + 60}px 0`
      : how === 'tiny' ? `background:url(${file}) no-repeat 0 0 / 16px auto`
        : `background:linear-gradient(#ffffff, #ffffff), url(${file}) no-repeat`;
    out.push(page(id, 'picture-text-background', hazardAt(n++), { body: `<div id="subject" style="width:${d.w}px;height:${d.h}px;${style}"></div>`, css: [], files: { [file]: d.svg } }, { '1.1.1': P, '1.4.5': P }, `a background notice that shows no word people can read (${how}): nothing to fail`, { key: how }, r));
  }
  // Not counted: a background notice that is cut off (cover in a short strip).
  for (let rep = 0; rep < 6; rep++) {
    const id = `picture-text-background/cut-off/${rep}`;
    const r = rng(hash(id) ^ seed);
    const d = noticeSvg(NOTICES[rep]!, 'left-plain', r);
    out.push(page(id, 'picture-text-background', hazardAt(n++), { body: `<div id="subject" style="height:70px;background:center / cover no-repeat url(/img/cut.svg)"></div>`, css: [], files: { '/img/cut.svg': d.svg } }, { '1.1.1': A, '1.4.5': A }, 'a background notice shown only in part: what of it people see is not measured (not counted)', { key: 'cut-off' }, r));
  }
  // The last fix round (15 failures of both, 2 not counted): a background notice on an empty element shown whole in a
  // container the picture test reads as the page is rendered; and kept out of sight by a closed panel (not counted).
  for (const [ci, where] of SHOWN_IN.filter((x) => x !== 'inline-link').entries()) {
    for (let rep = 0; rep < 3; rep++) {
      const id = `picture-text-background/shown-in-${where}/${rep}`;
      const r = rng(hash(id) ^ seed);
      const d = noticeSvg(NOTICES[(ci * 4 + rep * 7 + 3) % NOTICES.length]!, NOTICE_LAYOUTS.filter((l) => l !== 'clear-ground')[(ci + rep * 4) % 14]!, r);
      const file = `/themes/site/img/notice-s${ci}-${rep}.svg`;
      const c = drawnIn(where, `<div id="subject" style="width:${d.w}px;height:${d.h}px;background:url(${file}) no-repeat"></div>`);
      out.push(page(id, 'picture-text-background', hazardAt(n++), { body: c.html, css: [], files: { [file]: d.svg }, init: c.init }, { '1.1.1': F, '1.4.5': F }, `a notice as the CSS background of an empty element, shown whole in ${where}`, { key: `shown-in-${where}` }, r));
    }
  }
  for (let rep = 0; rep < 2; rep++) {
    const id = `picture-text-background/kept-in-component-closed-panel/${rep}`;
    const r = rng(hash(id) ^ seed);
    const d = noticeSvg(NOTICES[(rep * 13 + 6) % NOTICES.length]!, 'left-card', r);
    const c = drawnIn('component-closed-panel', `<div id="subject" style="width:${d.w}px;height:${d.h}px;background:url(/themes/site/img/kept.svg) no-repeat"></div>`);
    out.push(page(id, 'picture-text-background', hazardAt(n++), { body: c.html, css: [], files: { '/themes/site/img/kept.svg': d.svg }, init: c.init }, { '1.1.1': A, '1.4.5': A }, 'a background notice in a closed panel of a component as the page loads: what shows once it is opened is not measured (not counted)', { key: 'kept-in-component-closed-panel' }, r));
  }
  return out;
}

const common = { probes: () => [picturesProbe], full: false, read: 'probe' as const, readProbes: ['picture-text'], capMs: 60_000 };
export const pictureBlockTest: SimTest = { id: 'picture-text-block', criteria: ['1.4.5'], ...common, cases: blockCases };
export const pictureAltTest: SimTest = { id: 'picture-text-alt', criteria: ['1.1.1'], ...common, cases: altCases };
export const pictureHiddenTest: SimTest = { id: 'picture-text-hidden', criteria: ['1.1.1'], ...common, cases: hiddenCases };
export const pictureKindTest: SimTest = { id: 'picture-text-kind', criteria: ['1.1.1'], ...common, cases: kindCases };
export const pictureBackgroundTest: SimTest = { id: 'picture-text-background', criteria: ['1.1.1', '1.4.5'], ...common, cases: backgroundCases };
