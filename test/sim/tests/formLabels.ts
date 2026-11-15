// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Form labels: 3.3.2 Labels or Instructions, 1.3.1 Info and Relationships, 4.1.2 Name, Role, Value
// (probe `form-fields` and the axe rules mapped to them, read from the criteria table).
//
// Source of truth. SC 3.3.2: "Labels or instructions are provided when content requires user input."
// Sufficient techniques include H44 (label elements), ARIA9 (aria-labelledby), H71 (fieldset and legend)
// and G167 "Using an adjacent button to label the purpose of a field" ("the button also acts as a label
// for the input field"; "The field must also have a programmatically determined name, per Success
// Criterion 4.1.2"); its only listed failure is F82 (phone number fields formatted visually with no text
// label). Understanding 3.3.2 says nothing about placeholders as labels and lists required-field marks
// only as sufficient techniques (H90) and benefits, not as a failure. F68: "Failure of Success Criterion
// 4.1.2 due to a user interface control not having a programmatically determined name". F111: "Failure
// of Success Criteria 1.3.1, 2.5.3, and 4.1.2 due to a control with visible label text but no accessible
// name".
//
// The answer by construction (a form of three fields; the subject field is the second one, the others are
// labelled with <label for>):
// - pass on all three: <label for>, a wrapping label, aria-labelledby to visible text, a search field with
//   aria-label and an adjacent "Search" button (G167), a select with aria-label and an adjacent "Get form
//   for state" button (G167 example 3), a labelled select whose first option is a prompt ("Choose a
//   state"), a labelled field with a prefilled value, hidden fields (type=hidden and display:none) next
//   to labelled ones, labelled radios in a fieldset with a legend, a required field marked with an
//   asterisk explained at the top;
// - 3.3.2 fails, 4.1.2 and 1.3.1 pass: aria-label only, title only (nothing visible names the field),
//   Yes/No radios with no visible question;
// - 3.3.2 and 4.1.2 fail, 1.3.1 passes: no label, name or text at all;
// - 1.3.1 and 4.1.2 fail, 3.3.2 passes (F111): visible label text right before the field (a span, a
//   div above it, a table cell beside it, text after a checkbox) that is not associated with it;
// - 4.1.2 fails, 3.3.2 passes: G167 without a programmatic name (1.3.1 not counted: the button is the
//   visible label, whether F111 reaches it is for the lead); phone number in three fields with only the
//   first labelled (3.3.2 and 1.3.1 not counted: F82's case is fields with no text label at all);
// - not counted on 3.3.2 ('any'): placeholder-only label (1.3.1 and 4.1.2 pass: the placeholder is the
//   accessible name); a required field with no visible mark (others pass).
import { ariaStatesProbe } from '../../../src/probes/ariaStates.js';
import { formFieldsProbe } from '../../../src/probes/forms.js';
import { headingsProbe } from '../../../src/probes/headings.js';
import { namesProbe } from '../../../src/probes/names.js';
import { screenReaderLiveProbe, screenReaderProbe } from '../../../src/probes/screenReader/index.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Expectation, Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];

export const LABEL_KINDS = [
  'label-for', 'wrapped-label', 'labelledby', 'g167-search', 'g167-select', 'select-prompt', 'prefilled', 'hidden-fields', 'fieldset-radios', 'required-marked',
  'aria-label-only', 'title-only', 'radios-no-question', 'no-label',
  'f111-span', 'f111-div-above', 'f111-table-cell', 'f111-checkbox-text',
  'g167-unnamed', 'phone-split', 'placeholder-only', 'required-unmarked',
] as const;
type Kind = (typeof LABEL_KINDS)[number];

const P: Expectation = { verdict: 'pass' };
const F: Expectation = { verdict: 'fail', count: 1 };
const A: Expectation = { verdict: 'any' };

/** Expected 3.3.2, 1.3.1, 4.1.2 per kind. */
export const LABEL_EXPECT: Record<Kind, [Expectation, Expectation, Expectation, string]> = {
  'label-for': [P, P, P, '<label for>'],
  'wrapped-label': [P, P, P, 'a label wrapping the field'],
  labelledby: [P, P, P, 'aria-labelledby to visible text (ARIA9)'],
  'g167-search': [P, P, P, 'a search field named by aria-label with an adjacent Search button (G167)'],
  'g167-select': [P, P, P, 'a select named by aria-label with an adjacent "Get form for state" button (G167 example 3)'],
  'select-prompt': [P, P, P, 'a labelled select whose first option is a prompt'],
  prefilled: [P, P, P, 'a labelled field with a prefilled value'],
  'hidden-fields': [P, P, P, 'hidden fields (type=hidden, display:none) next to labelled ones'],
  'fieldset-radios': [P, P, P, 'labelled radios in a fieldset with a legend (H71)'],
  'required-marked': [P, P, P, 'a required field marked with an asterisk, explained at the top (H90)'],
  'aria-label-only': [F, P, P, 'only aria-label: nothing visible names the field'],
  'title-only': [F, P, P, 'only a title: nothing visible names the field'],
  'radios-no-question': [F, P, P, 'Yes/No radios with no visible question'],
  'no-label': [F, P, F, 'no label, name or text at all (F68)'],
  'f111-span': [P, F, F, 'visible text in a span before the field, not associated (F111)'],
  'f111-div-above': [P, F, F, 'visible text in a div above the field, not associated (F111)'],
  'f111-table-cell': [P, F, F, 'visible text in the table cell beside the field, not associated (F111)'],
  'f111-checkbox-text': [P, F, F, 'visible text after a checkbox, not associated (F111)'],
  // Lead's rulings (2026-11-07): G167 without a name is not counted for 1.3.1 (4.1.2 covers the missing name);
  // the split phone number is not counted for 3.3.2 or 1.3.1; a placeholder as the only label and a required
  // field with no visible mark are not counted for 3.3.2 (no WCAG failure technique names either; the engine
  // is to report them as recommendations).
  'g167-unnamed': [P, A, F, 'a search field with an adjacent Search button but no programmatic name (G167 requires one for 4.1.2)'],
  'phone-split': [A, A, F, 'phone number in three fields, only the first labelled: the other two have no name (F68)'],
  'placeholder-only': [A, P, P, 'placeholder as the only label: WCAG 3.3.2 does not say; not counted'],
  'required-unmarked': [A, P, P, 'a required field with no visible mark: WCAG lists marks as sufficient, not a failure; not counted'],
};

export function labelCase(kind: Kind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `form-labels/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const first = '<p><label for="name">Your name</label><br><input id="name" name="name" type="text" autocomplete="name"></p>';
  const last = '<p><label for="phone2">Daytime phone</label><br><input id="phone2" name="dayphone" type="tel" autocomplete="tel"></p>';
  let subject = '';
  let formAttrs = '';
  let lead = '';
  let wrapLast = true;
  switch (kind) {
    case 'label-for': subject = '<p><label for="s">E-mail address</label><br><input id="s" name="email" type="email" autocomplete="email"></p>'; break;
    case 'wrapped-label': subject = '<p><label>E-mail address<br><input name="email" type="email" autocomplete="email"></label></p>'; break;
    case 'labelledby': subject = '<p><span id="sl">E-mail address</span><br><input aria-labelledby="sl" name="email" type="email" autocomplete="email"></p>'; break;
    case 'g167-search':
      return finish(`<form role="search" action="/search" method="get"><p><input type="search" name="q" aria-label="Search" autocomplete="off"> <button type="submit">Search</button></p></form>`);
    case 'g167-select':
      return finish(`<form action="/forms" method="get"><p><select name="state" aria-label="State"><option>Alabama</option><option>Alaska</option><option>Arizona</option></select> <button type="submit">Get form for state</button></p></form>`);
    case 'g167-unnamed':
      return finish(`<form role="search" action="/search" method="get"><p><input type="search" name="q" autocomplete="off"> <button type="submit">Search</button></p></form>`);
    case 'select-prompt': subject = '<p><label for="s">State</label><br><select id="s" name="state" autocomplete="address-level1"><option value="">Choose a state</option><option>Alabama</option><option>Alaska</option></select></p>'; break;
    case 'prefilled': subject = '<p><label for="s">City</label><br><input id="s" name="city" type="text" autocomplete="address-level2" value="Springfield"></p>'; break;
    case 'hidden-fields': subject = '<input type="hidden" name="token" value="a1b2c3"><input type="text" name="extra" style="display:none"><p><label for="s">E-mail address</label><br><input id="s" name="email" type="email" autocomplete="email"></p>'; break;
    case 'fieldset-radios': subject = '<fieldset><legend>Do you own a dog?</legend><input type="radio" id="y" name="dog" value="y"> <label for="y">Yes</label> <input type="radio" id="n" name="dog" value="n"> <label for="n">No</label></fieldset>'; break;
    case 'required-marked':
      lead = '<p>Fields marked * are required.</p>';
      subject = '<p><label for="s">E-mail address *</label><br><input id="s" name="email" type="email" autocomplete="email" required aria-required="true"></p>';
      break;
    case 'required-unmarked': subject = '<p><label for="s">E-mail address</label><br><input id="s" name="email" type="email" autocomplete="email" required></p>'; break;
    case 'aria-label-only': subject = '<p><input aria-label="E-mail address" name="email" type="email" autocomplete="email"></p>'; break;
    case 'title-only': subject = '<p><input title="E-mail address" name="email" type="email" autocomplete="email"></p>'; break;
    case 'radios-no-question': subject = '<p><input type="radio" id="y" name="dog" value="y"> <label for="y">Yes</label> <input type="radio" id="n" name="dog" value="n"> <label for="n">No</label></p>'; break;
    case 'no-label': subject = '<p><input name="email" type="email" autocomplete="email"></p>'; break;
    case 'f111-span': subject = '<p><span>E-mail address</span> <input name="email" type="email" autocomplete="email"></p>'; break;
    case 'f111-div-above': subject = '<div class="lbl">E-mail address</div><div><input name="email" type="email" autocomplete="email"></div>'; break;
    case 'f111-table-cell':
      subject = '<table role="presentation"><tr><td>E-mail address</td><td><input name="email" type="email" autocomplete="email"></td></tr></table>';
      break;
    case 'f111-checkbox-text': subject = '<p><input type="checkbox" name="news" value="1"> Send me the newsletter</p>'; break;
    case 'phone-split':
      subject = '<p><label for="ph1">Phone number</label><br>(<input id="ph1" name="ph1" type="text" inputmode="numeric" size="3" maxlength="3">) <input name="ph2" type="text" inputmode="numeric" size="3" maxlength="3"> - <input name="ph3" type="text" inputmode="numeric" size="4" maxlength="4"></p>';
      wrapLast = false;
      break;
    case 'placeholder-only': subject = '<p><input placeholder="E-mail address" name="email" type="email" autocomplete="email"></p>'; break;
  }
  return finish(`<form action="/contact" method="post"${formAttrs}>${lead}${first}${subject}${wrapLast ? last : ''}<p><button type="submit">Send</button></p></form>`);

  function finish(form: string): SimCase {
    const css = ['input, select, button { font: 16px Arial; padding: 4px; border: 2px solid #1b1b1b; } fieldset { border: 1px solid #555; } input:focus-visible, select:focus-visible, button:focus-visible { outline: 3px solid #00376d; outline-offset: 2px; } td { padding: 4px; }'];
    const pg = parts('Contact the city', `<p>Send us a message.</p>${form}${filler(r, 2)}`, css);
    applyHazard(pg, hazard, r);
    const [e332, e131, e412, why] = LABEL_EXPECT[kind];
    return { id, test: 'form-labels', hazard, params: { kind }, site: render(pg), expect: { '3.3.2': e332, '1.3.1': e131, '4.1.2': e412 }, why };
  }
}

export function labelCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const kind of LABEL_KINDS) {
    const [a, b] = LABEL_EXPECT[kind];
    const reps = a.verdict === 'fail' ? 13 : b.verdict === 'fail' ? 13 : a.verdict === 'pass' && b.verdict === 'pass' && LABEL_EXPECT[kind][2].verdict === 'pass' ? 6 : 8;
    for (let rep = 0; rep < reps; rep++) out.push(labelCase(kind, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  return out;
}

export const formLabelsTest: SimTest = {
  id: 'form-labels', criteria: ['3.3.2', '1.3.1', '4.1.2'], probes: () => [headingsProbe, ariaStatesProbe, namesProbe, screenReaderProbe, formFieldsProbe, screenReaderLiveProbe], full: false, read: 'criterion', capMs: 90_000, cases: labelCases,
};
