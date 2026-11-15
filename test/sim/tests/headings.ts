// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Headings: 1.3.1 Info and Relationships and 2.4.6 Headings and Labels (probe `headings` and the axe
// rules mapped to 1.3.1, read from the criteria table).
//
// Source of truth. Understanding 1.3.1 lists H42 "Using h1-h6 to identify headings" and ARIA12 "Using
// role=heading to identify headings" as sufficient, G141 "Organizing a page using headings" as advisory
// only, and the failures F2 "using changes in text presentation to convey information without using the
// appropriate markup or text", F43 "using structural markup in a way that does not represent
// relationships in the content" and F92 "the use of role presentation on content which conveys semantic
// information". It says nothing that requires a level-1 heading or forbids skipping levels (heading
// order is G141, advisory; a logical outline is 2.4.10 Section Headings, Level AAA). SC 2.4.6:
// "Headings and labels describe topic or purpose"; ACT b49b2e "Heading is descriptive". ACT ffd0e9
// "Heading has non-empty accessible name" maps to WAI-ARIA 1.2, not to a WCAG criterion.
//
// The answer by construction (four sections about city services, each with a heading and text):
// - pass on both: h1 + h2/h3 in order; levels that skip (h1 → h3 → h5); no h1 at all (the page starts at
//   h2); two h1s; levels going up out of order (h3 before h2); a visually hidden h1; role="heading"
//   aria-level; an h1 that is an image with alt text;
// - 1.3.1 fails (2.4.6 passes): every section title is a div styled 22 px bold (F2); a bold 22 px <p>
//   (F2, the pattern axe's p-as-heading looks for); h2 role="presentation" (F92);
// - 2.4.6 fails (1.3.1 passes): the sections are marked up as h2 but their text does not describe the
//   section ("Heading", "Section", "Untitled", "Lorem ipsum") (ACT b49b2e);
// - an empty h2 among the sections: not counted ('any') on either criterion, since WCAG names no
//   failure for it (ACT ffd0e9 maps to ARIA); the lead rules.
// - 1.3.1 fails by construction (red-team lane D, 2026-11-10: F2 where the page itself proves the styled text is
//   a heading, so no judgement is left): two sections with real h2s and two whose titles are paragraphs set
//   exactly like those h2s (twin-titles). Its look-alikes pass: a styled subtitle under each real h2
//   (subtitles), and titles set like the real h2s that are the labels of groups (group-labels: text that names
//   something else is never an unmarked heading).
// - Not counted ('any', review round 1, ruling 4: a class name or a place is a candidate, never proof, so the
//   test leaves them undecided): section titles in divs the page's own class calls a title (named-titles), and
//   a box that starts with a larger bold paragraph beside boxes that start with an h2 (peer-titles).
import { headingsProbe } from '../../../src/probes/headings.js';
import { formFieldsProbe } from '../../../src/probes/forms.js';
import { screenReaderProbe } from '../../../src/probes/screenReader/index.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Expectation, Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];
const TOPICS = ['Parking permits', 'Park reservations', 'Trash and recycling', 'Water service'] as const;
const VAGUE = ['Heading', 'Section', 'Untitled', 'Lorem ipsum'] as const;

export const HEADING_KINDS = [
  'in-order', 'skip-levels', 'no-h1', 'two-h1', 'out-of-order', 'sr-only-h1', 'role-heading', 'image-h1',
  'div-titles', 'bold-p-titles', 'presentation-role', 'vague-titles', 'empty-heading',
  // Appended (2026-11-10), so the cases before them keep their ids and hazards.
  'named-titles', 'twin-titles', 'peer-titles', 'subtitles', 'group-labels',
] as const;
type Kind = (typeof HEADING_KINDS)[number];

const PASS: Expectation = { verdict: 'pass' };
const FAIL: Expectation = { verdict: 'fail', count: 1 };

export function headingCase(kind: Kind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `headings/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const text = () => filler(r, 1, 30);
  const css = ['.t { font: bold 22px/1.3 Arial; margin: 24px 0 8px; color: #1b1b1b; } .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }'
    + ' .big { font: bold 20px/1.3 Georgia, serif; margin: 20px 0 6px; } .st { font: bold 19px/1.3 Arial; margin: 0 0 8px; color: #333; }'];
  let noH1 = false;
  let top = '';
  const sec = (h: string, i: number) => `<section>${h}${text()}${i === 1 ? text() : ''}</section>`;
  let body = '';
  switch (kind) {
    case 'in-order':
      body = TOPICS.map((t, i) => sec(i === 3 ? `<h3>${t}</h3>` : `<h2>${t}</h2>`, i)).join('');
      break;
    case 'skip-levels':
      body = TOPICS.map((t, i) => sec(`<h${[3, 5, 3, 4][i]}>${t}</h${[3, 5, 3, 4][i]}>`, i)).join('');
      break;
    case 'no-h1':
      noH1 = true;
      top = '<p>City services for residents.</p>';
      body = TOPICS.map((t, i) => sec(`<h2>${t}</h2>`, i)).join('');
      break;
    case 'two-h1':
      body = TOPICS.map((t, i) => sec(i === 2 ? `<h1>${t}</h1>` : `<h2>${t}</h2>`, i)).join('');
      break;
    case 'out-of-order':
      body = TOPICS.map((t, i) => sec(`<h${[3, 2, 4, 2][i]}>${t}</h${[3, 2, 4, 2][i]}>`, i)).join('');
      break;
    case 'sr-only-h1':
      noH1 = true;
      top = '<h1 class="sr">City services</h1>';
      body = TOPICS.map((t, i) => sec(`<h2>${t}</h2>`, i)).join('');
      break;
    case 'role-heading':
      body = TOPICS.map((t, i) => sec(`<div role="heading" aria-level="2" class="t">${t}</div>`, i)).join('');
      break;
    case 'image-h1':
      noH1 = true;
      top = '<h1><img src="/logo.svg" alt="City services" width="240" height="40"></h1>';
      body = TOPICS.map((t, i) => sec(`<h2>${t}</h2>`, i)).join('');
      break;
    case 'div-titles':
      body = TOPICS.map((t, i) => sec(`<div class="t">${t}</div>`, i)).join('');
      break;
    case 'bold-p-titles':
      body = TOPICS.map((t, i) => sec(`<p class="t">${t}</p>`, i)).join('');
      break;
    case 'presentation-role':
      body = TOPICS.map((t, i) => sec(`<h2 role="presentation" class="t">${t}</h2>`, i)).join('');
      break;
    case 'vague-titles':
      body = TOPICS.map((_, i) => sec(`<h2>${VAGUE[(i + rep) % VAGUE.length]}</h2>`, i)).join('');
      break;
    case 'empty-heading':
      body = TOPICS.map((t, i) => sec(i === 1 ? '<h2></h2>' : `<h2>${t}</h2>`, i)).join('');
      break;
    case 'named-titles':
      body = TOPICS.map((t, i) => sec(`<div class="t ${['section-title', 'sectionHeading', 'block-title', 'widget_title'][(i + rep) % 4]}">${t}</div>`, i)).join('');
      break;
    case 'twin-titles':
      body = TOPICS.map((t, i) => sec(i < 2 ? `<h2 class="t">${t}</h2>` : `<p class="t">${t}</p>`, i)).join('');
      break;
    case 'peer-titles':
      body = TOPICS.map((t, i) => sec(i === (rep % 4) ? `<p class="big">${t}</p>` : `<h2>${t}</h2>`, i)).join('');
      break;
    case 'subtitles':
      body = TOPICS.map((t, i) => sec(`<h2>${t}</h2><p class="st ${['subtitle', 'tagline', 'page-subtitle', 'lead'][(i + rep) % 4]}">Updated every week by the city office</p>`, i)).join('');
      break;
    case 'group-labels':
      // Two real h2s, and two titles set exactly like them that label a group (tied, or the group's first line).
      body = TOPICS.map((t, i) => (i < 2 ? sec(`<h2 class="t">${t}</h2>`, i)
        : `<div role="${['group', 'region'][(i + rep) % 2]}"${(i + rep) % 3 ? ` aria-labelledby="gl${i}"` : ''}>${sec(`<p class="t" id="gl${i}">${t}</p>`, i)}</div>`)).join('');
      break;
  }
  const pg = parts('City services', `${top}<p>What the city does for you.</p>${body}`, css);
  pg.noH1 = noH1;
  if (kind === 'image-h1') pg.files['/logo.svg'] = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="40" viewBox="0 0 240 40"><rect width="240" height="40" fill="#fff"/><text x="0" y="30" font-family="Arial" font-size="28" fill="#1b1b1b">City services</text></svg>';
  applyHazard(pg, hazard, r);
  // Lead's ruling (Sol round 2, 2026-11-07): F2 and F92 are AI-review cases. Whether bold text or a de-roled heading
  // serves as a section heading is a judgement, so the deterministic test only lists them (never scores them) and
  // these cases are left out of its recall ('any'), not relabelled as passes.
  const aiReview = kind === 'div-titles' || kind === 'bold-p-titles' || kind === 'presentation-role';
  const f131 = kind === 'twin-titles';
  // Review round 1, ruling 4: a class name or a place makes a candidate, never a proof: undecided, not counted.
  const candidate = kind === 'named-titles' || kind === 'peer-titles';
  const f246 = kind === 'vague-titles';
  // Lead's ruling (2026-11-07): an empty heading is not counted on either criterion.
  const any = kind === 'empty-heading';
  const WHY: Record<Kind, string> = {
    'in-order': 'headings h1, h2, h3 in order', 'skip-levels': 'levels skip (h1, h3, h5): no WCAG A/AA requirement (G141 is advisory)',
    'no-h1': 'no level-1 heading: no WCAG A/AA requirement', 'two-h1': 'two level-1 headings: allowed', 'out-of-order': 'levels out of order: allowed',
    'sr-only-h1': 'a visually hidden h1', 'role-heading': 'role="heading" aria-level="2" (ARIA12)', 'image-h1': 'an h1 that is an image with alt text',
    'div-titles': 'section titles are styled divs, not headings (F2)', 'bold-p-titles': 'section titles are bold paragraphs, not headings (F2)',
    'presentation-role': 'h2 role="presentation" removes the heading (F92)', 'vague-titles': 'headings do not describe their sections (ACT b49b2e)',
    'empty-heading': 'an empty h2 (ACT ffd0e9 maps to ARIA, not WCAG): not counted',
    'named-titles': 'section titles are styled divs the page\'s own class calls a title or heading: a candidate, not proof (undecided, not counted)',
    'twin-titles': 'two section titles are paragraphs set exactly like the page\'s real h2s (F2, proven by the page)',
    'peer-titles': 'one box starts with a larger bold paragraph where the boxes beside it start with an h2: a candidate, not proof (undecided, not counted)',
    'subtitles': 'a styled subtitle under each real heading: not a section heading',
    'group-labels': 'titles set like the real headings that are the labels of groups and regions: they name something else, so they are no unmarked headings',
  };
  return {
    id, test: 'headings', hazard, params: { kind },
    site: render(pg),
    expect: {
      '1.3.1': any || aiReview || candidate ? { verdict: 'any' } : f131 ? FAIL : PASS,
      '2.4.6': any ? { verdict: 'any' } : f246 ? FAIL : PASS,
    },
    why: aiReview ? `AI-review case (judgement, not deterministic): ${WHY[kind]}` : WHY[kind],
  };
}

export function headingCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const kind of HEADING_KINDS) {
    const reps = kind === 'vague-titles' ? 54 : kind === 'div-titles' || kind === 'bold-p-titles' || kind === 'presentation-role' ? 18 : kind === 'empty-heading' ? 6
      : kind === 'named-titles' || kind === 'peer-titles' ? 20 : kind === 'twin-titles' ? 60 : kind === 'subtitles' || kind === 'group-labels' ? 20 : 8;
    for (let rep = 0; rep < reps; rep++) out.push(headingCase(kind, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  return out;
}

export const headingsTest: SimTest = {
  id: 'headings', criteria: ['1.3.1', '2.4.6'], probes: () => [headingsProbe, screenReaderProbe, formFieldsProbe], full: false, read: 'criterion', capMs: 90_000, cases: headingCases,
};
