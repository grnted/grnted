// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, forms lane (docs/atlas/forms.md): the lab of the new decision paths, generated across the atlas's variant
// space (never around the training pages): each failure and its look-alikes in four platform skins (plain markup,
// Bootstrap rows, a Gravity Forms list, Drupal form items), with seeded wording and harness hazards. The answer is
// known by construction; each case says why.
//
// - `b18-steps` (3.3.7): D5 steps by cause (a hidden step, a second form the first one's send reveals, a step a script
//   renders), D6 sameness (an "again" label, the same person's detail in other words, the step's own words), D7
//   availability (carried forward, shown as text, a reuse button, a datalist, a "same as" box) and the D6 look-alikes
//   (a signature, a second applicant).
// - `b18-labels` (3.3.2): D8 required only after sending, D17 G167 by words, D19 phone width and vanishing labels,
//   D20 CSS-drawn markers and labels, ruling Q6 (a heading over different questions; parts of one value).
// - `b18-errors` (3.3.1, 3.3.3, 4.1.3): D9 symbol-only errors, D11 browser and restating messages, D12 statuses after a
//   choice, D14 one meaning of "announced".
// - `b18-commit` (1.3.5, 3.2.2, 3.3.4, 3.3.8): D21 purpose breadth, D15 advised beforehand, D22 bank and frame
//   payments, D23 log-in fields and positional secrets.
import { formFieldsProbe, formsProbe } from '../../../src/probes/forms.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Expectation, Hazard, SimCase, SimTest } from '../types.js';
// Written by a fresh subagent from the WCAG criterion text alone (precision fix, lead's ruling 2026-11-13).
import { BEFORE_FORM_REQUIRED, FORMAT_INSTRUCTIONS, FORM_WIDE_REQUIRED, NEUTRAL_FORM_TEXT, PER_FIELD_REQUIRED } from './b18Phrasings.js';

const HAZARDS: readonly Hazard[] = ['none', 'cookie-banner', 'sticky-header', 'late-mount'];
const SKINS = ['plain', 'bootstrap', 'gform', 'drupal'] as const;
type Skin = (typeof SKINS)[number];

const P: Expectation = { verdict: 'pass' };
const F: Expectation = { verdict: 'fail' };
const A: Expectation = { verdict: 'any' };

const CSS = [
  'body { font: 16px/1.5 Arial, sans-serif; color: #1b1b1b; background: #fff; } label { display: block; margin-top: 10px; }',
  'input, select, textarea, button { font: inherit; padding: 4px; border: 2px solid #1b1b1b; } .gform_fields { list-style: none; padding: 0; }',
  '.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }',
];

/** Adds a class to the first element of `tags` in `html`, into its own class attribute when it has one. */
function addClass(html: string, tags: string, cls: string): string {
  const re = new RegExp(`<(${tags})\\b([^>]*)>`);
  return html.replace(re, (_m, tag: string, attrs: string) => (/\sclass="/.test(attrs)
    ? `<${tag}${attrs.replace(/\sclass="/, ` class="${cls} `)}>`
    : `<${tag} class="${cls}"${attrs}>`));
}
/** One field row in a skin: its label (or other text) and its control. */
function row(skin: Skin, label: string, control: string): string {
  switch (skin) {
    case 'plain': return `<p>${label}<br>${control}</p>`;
    case 'bootstrap': return `<div class="mb-3">${addClass(label, 'label', 'form-label')}${addClass(control, 'input|select|textarea', 'form-control')}</div>`;
    case 'gform': return `<li class="gfield">${addClass(label, 'label', 'gfield_label')}<div class="ginput_container">${control}</div></li>`;
    case 'drupal': return `<div class="js-form-item form-item">${addClass(label, 'label', 'form-item__label')}${addClass(control, 'input|select|textarea', 'form-text')}</div>`;
  }
}
/** Rows in the skin's own list or box. */
const block = (skin: Skin, rows: string[]) => (skin === 'gform' ? `<ul class="gform_fields">${rows.join('')}</ul>` : rows.join(''));
const lab = (id: string, text: string) => `<label for="${id}">${text}</label>`;

interface Built { body: string; init?: string[]; css?: string[]; expect: Record<string, Expectation>; why: string }

function finish(test: string, id: string, kind: string, skin: Skin, hazard: Hazard, seed: number, title: string, b: Built): SimCase {
  const r = rng(hash(id) ^ seed);
  const pg = parts(title, `${filler(r, 1)}${b.body}${filler(r, 1)}`, [...CSS, ...(b.css ?? [])], b.init ?? []);
  applyHazard(pg, hazard, r);
  return { id, test, hazard, params: { kind, skin }, site: render(pg), expect: b.expect, why: b.why };
}

/** Cases for every kind of a test: `reps` per kind and skin, hazards in turn, wording picked by the seed. */
function generate(test: string, kinds: Record<string, { reps: number; title: string; build: (skin: Skin, pick: <T>(xs: readonly T[]) => T, rep: number) => Built }>, seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const [kind, k] of Object.entries(kinds)) {
    for (const skin of SKINS) {
      for (let rep = 0; rep < k.reps; rep++) {
        const id = `${test}/${kind}/${skin}/${rep}`;
        const r = rng(hash(`${id}:words`) ^ seed);
        const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
        out.push(finish(test, id, kind, skin, HAZARDS[i++ % HAZARDS.length]!, seed, k.title, k.build(skin, pick, rep)));
      }
    }
  }
  return out;
}

// ---- b18-steps (3.3.7) ----------------------------------------------------------------------------------------------

const SHAPES = ['hidden-step', 'two-forms', 'rendered'] as const;
const STEP_BUTTONS = ['Continue', 'Save and continue', 'Next step'] as const;
/** Step 1 and step 2 of a two-step request, by proof or look-alike, in a process shape. */
function stepCase(kind: string, shape: (typeof SHAPES)[number], skin: Skin, button: string): Built {
  // Step 1 always asks for a name and an email (the email is what later steps may ask again).
  const emailLabel = kind === 'person-other-words' ? 'Email for your review' : 'Contact email';
  const s1 = block(skin, [
    row(skin, lab('s1n', 'Full name'), '<input id="s1n" name="s1n" autocomplete="name" required>'),
    row(skin, lab('s1e', emailLabel), '<input id="s1e" type="email" name="s1e" autocomplete="email" required>'),
    ...(kind === 'step-text' ? [row(skin, lab('s1c', 'Program code'), '<input id="s1c" name="s1c" required>')] : []),
  ]);
  let intro = '<h2>Step 2: Details</h2>';
  let s2rows: string[] = [];
  let after = '';
  switch (kind) {
    case 'again-label': s2rows = [row(skin, lab('s2e', 'Contact email again'), '<input id="s2e" type="email" name="s2e" autocomplete="off">')]; break;
    case 'person-other-words': s2rows = [row(skin, lab('s2e', 'Email for the decision letter'), '<input id="s2e" type="email" name="s2e" autocomplete="off">')]; break;
    case 'step-text': intro += '<p>For this request, enter the program code again.</p>'; s2rows = [row(skin, lab('s2c', 'Program code'), '<input id="s2c" name="s2c">')]; break;
    case 'prefilled': s2rows = [row(skin, lab('s2e', 'Contact email'), '<input id="s2e" type="email" name="s2e" autocomplete="email">')]; after = "document.getElementById('s2e').value=v;"; break;
    case 'shown-text': intro += '<p>We will write to <b id="shown"></b>.</p>'; s2rows = [row(skin, lab('s2e', 'Contact email again'), '<input id="s2e" type="email" name="s2e" autocomplete="off">')]; after = "document.getElementById('shown').textContent=v;"; break;
    case 'signature': s2rows = [row(skin, lab('s2s', 'Type your full name to sign'), '<input id="s2s" name="s2s" autocomplete="off">')]; break;
    case 'second-applicant': intro = '<h2>Second applicant</h2>'; s2rows = [row(skin, lab('s2e', 'Email'), '<input id="s2e" type="email" name="s2e" autocomplete="off">')]; break;
    case 'copy-button': s2rows = [row(skin, lab('s2e', 'Contact email again'), '<input id="s2e" type="email" name="s2e" autocomplete="off"> <button type="button" id="cp">Use my email from the first step</button>')]; after = "document.getElementById('cp').onclick=()=>{document.getElementById('s2e').value=v;};"; break;
    case 'datalist': s2rows = [row(skin, lab('s2e', 'Contact email again'), '<input id="s2e" type="email" name="s2e" autocomplete="off" list="prev"><datalist id="prev"></datalist>')]; after = "const o=document.createElement('option');o.value=v;document.getElementById('prev').append(o);"; break;
    // Fix round (Sol S1, S12): another kind of the person's detail, one that may differ, a person the step asks about;
    // a reuse box about something else offers nothing.
    case 'work-home': s2rows = [row(skin, lab('s2e', 'Home email'), '<input id="s2e" type="email" name="s2e" autocomplete="home email">')]; break;
    case 'if-different': s2rows = [row(skin, lab('s2e', 'Email for the decision letter (if different)'), '<input id="s2e" type="email" name="s2e" autocomplete="off">')]; break;
    case 'who-contact': intro = '<h2>Who should we contact about the room?</h2>'; s2rows = [row(skin, lab('s2e', 'Email'), '<input id="s2e" type="email" name="s2e" autocomplete="off">')]; break;
    case 'reuse-unrelated': s2rows = [row(skin, lab('s2e', 'Contact email again'), '<input id="s2e" type="email" name="s2e" autocomplete="off">'), row(skin, '', '<label><input type="checkbox" id="prn"> Use my saved print settings</label>')]; break;
    case 'same-as-box': s2rows = [row(skin, lab('s2e', 'Contact email again'), '<input id="s2e" type="email" name="s2e" autocomplete="off">'), row(skin, '', '<label><input type="checkbox" id="same"> Same as above</label>')]; after = "document.getElementById('same').onchange=e=>{if(e.target.checked)document.getElementById('s2e').value=v;};"; break;
  }
  s2rows.push(row(skin, lab('s2p', 'How will you use the room?'), '<textarea id="s2p" name="s2p"></textarea>'));
  const s2 = `${intro}${block(skin, s2rows)}`;
  const send = "e.preventDefault();document.getElementById('done').textContent='Request saved.';";
  const v = "const v=document.getElementById('s1e').value;";
  let body = '';
  let init = '';
  switch (shape) {
    case 'hidden-step':
      body = `<form id="f" novalidate><div id="one"><h2>Step 1: Contact</h2>${s1}<p><button type="button" id="go">${button}</button></p></div><div id="two" hidden>${s2}<p><button type="submit">Send request</button></p></div><p id="done" role="status"></p></form>`;
      init = `document.getElementById('go').addEventListener('click',()=>{if(!document.getElementById('s1e').value)return;${v}document.getElementById('one').hidden=true;document.getElementById('two').hidden=false;${after}});document.getElementById('f').addEventListener('submit',e=>{${send}});`;
      break;
    case 'two-forms':
      body = `<form id="f1"><h2>Step 1: Contact</h2>${s1}<p><button type="submit">${button}</button></p></form><section id="two" hidden><form id="f2" novalidate>${s2}<p><button type="submit">Send request</button></p><p id="done" role="status"></p></form></section>`;
      init = `document.getElementById('f1').addEventListener('submit',e=>{e.preventDefault();${v}e.target.hidden=true;document.getElementById('two').hidden=false;${after}});document.getElementById('f2').addEventListener('submit',e=>{${send}});`;
      break;
    case 'rendered':
      body = `<form id="f" novalidate><div id="body"><h2>Step 1: Contact</h2>${s1}</div><p><button type="button" id="go">${button}</button></p><p id="done" role="status"></p></form><template id="t2">${s2}</template>`;
      init = `document.getElementById('go').addEventListener('click',()=>{const e1=document.getElementById('s1e');if(!e1)return;if(!e1.value)return;${v}document.getElementById('body').innerHTML=document.getElementById('t2').innerHTML;document.getElementById('go').textContent='Send request';${after}});`;
      break;
  }
  const fails = ['again-label', 'person-other-words', 'step-text', 'reuse-unrelated'].includes(kind);
  return { body, init: [init], expect: { '3.3.7': fails ? F : P }, why: `${shape}, "${button}": ${kind}` };
}

export function stepsCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  const FAILS = ['again-label', 'person-other-words', 'step-text', 'reuse-unrelated'];
  const LOOKS = ['prefilled', 'shown-text', 'signature', 'second-applicant', 'copy-button', 'datalist', 'same-as-box', 'work-home', 'if-different', 'who-contact'];
  const skins: Skin[] = ['plain', 'bootstrap', 'gform'];
  for (const shape of SHAPES) {
    for (const skin of skins) {
      for (const kind of FAILS) for (const button of STEP_BUTTONS) {
        const id = `b18-steps/${kind}/${shape}/${skin}/${button.replace(/\s+/g, '-')}`;
        out.push(finish('b18-steps', id, kind, skin, HAZARDS[i++ % HAZARDS.length]!, seed, 'Request a room', stepCase(kind, shape, skin, button)));
      }
      for (const kind of LOOKS) {
        const id = `b18-steps/${kind}/${shape}/${skin}`;
        out.push(finish('b18-steps', id, kind, skin, HAZARDS[i++ % HAZARDS.length]!, seed, 'Request a room', stepCase(kind, shape, skin, 'Continue')));
      }
    }
  }
  return out;
}

// ---- b18-labels (3.3.2) ---------------------------------------------------------------------------------------------

const PEOPLE = [['Full name', 'Street address', 'Town'], ['Your name', 'Mailing address', 'City'], ['Applicant name', 'Home address', 'Postal code']] as const;
const ACTIONS = ['Subscribe', 'Request callback', 'Sign me up', 'Check status', 'Go'] as const;

const labelKinds: Parameters<typeof generate>[1] = {
  // D8: required only after sending (the empty send names every field).
  'req-by-script': {
    reps: 8, title: 'Apply for a library card', build: (skin, pick) => {
      const f = pick(PEOPLE);
      const rows = f.map((t, j) => row(skin, lab(`q${j}`, t), `<input id="q${j}" name="q${j}">`));
      return {
        body: `<form id="c" novalidate>${block(skin, rows)}<p><button>Start application</button></p><p id="r" role="status"></p></form>`,
        init: [`document.getElementById('c').addEventListener('submit',e=>{e.preventDefault();const need=[...e.target.querySelectorAll('input')].filter(i=>!i.value.trim());document.getElementById('r').textContent=need.length?'Enter your '+need.map(i=>i.labels[0].textContent.toLowerCase()).join(', ')+' to continue.':'Your application has been started.';});`],
        expect: { '3.3.2': F }, why: 'every field is demanded only when the form is sent; nothing said so before',
      };
    },
  },
  'req-all-note': {
    reps: 2, title: 'Apply for a library card', build: (skin, pick) => {
      const f = pick(PEOPLE);
      const rows = f.map((t, j) => row(skin, lab(`q${j}`, t), `<input id="q${j}" name="q${j}">`));
      return { body: `<form id="c" novalidate><p>All fields are required.</p>${block(skin, rows)}<p><button>Start application</button></p><p id="r" role="status"></p></form>`, init: [`document.getElementById('c').addEventListener('submit',e=>{e.preventDefault();const n=[...e.target.querySelectorAll('input')].some(i=>!i.value.trim());document.getElementById('r').textContent=n?'Please fill in every field.':'Started.';});`], expect: { '3.3.2': P }, why: '"All fields are required." before the fields' };
    },
  },
  'req-optional': {
    reps: 2, title: 'Apply for a library card', build: (skin, pick) => {
      const f = pick(PEOPLE);
      const rows = f.map((t, j) => row(skin, lab(`q${j}`, j === 2 ? `${t} (optional)` : t), `<input id="q${j}" name="q${j}">`));
      return { body: `<form id="c" novalidate>${block(skin, rows)}<p><button>Start application</button></p><p id="r" role="status"></p></form>`, init: [`document.getElementById('c').addEventListener('submit',e=>{e.preventDefault();const need=[...e.target.querySelectorAll('input')].slice(0,2).filter(i=>!i.value.trim());document.getElementById('r').textContent=need.length?'Enter your '+need.map(i=>i.labels[0].textContent.toLowerCase()).join(' and ')+'.':'Started.';});`], expect: { '3.3.2': P }, why: 'the optional field is marked "(optional)": the others are required by that convention (ruling Q8)' };
    },
  },
  'req-css-icon': {
    reps: 2, title: 'Contact us', build: (skin, pick) => {
      const f = pick(PEOPLE);
      const rows = f.slice(0, 2).map((t, j) => row(skin, `<label for="q${j}" class="req">${t}</label>`, `<input id="q${j}" name="q${j}" required>`));
      return { body: `<form id="c">${block(skin, rows)}<p><button>Send</button></p></form>`, css: ['.req::after { content: ""; display: inline-block; width: 10px; height: 10px; margin-left: 4px; background-image: url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 10 10%27%3E%3Ctext y=%279%27 font-size=%2712%27 fill=%27%23b00000%27%3E*%3C/text%3E%3C/svg%3E"); }'], expect: { '3.3.2': P }, why: 'the required marker is a picture a stylesheet draws beside each label (D20)' };
    },
  },
  'req-sentence': {
    reps: 2, title: 'Contact us', build: (skin, pick) => {
      const f = pick(PEOPLE);
      const rows = f.slice(0, 2).map((t, j) => row(skin, lab(`q${j}`, t), `<input id="q${j}" name="q${j}" required>`));
      return { body: `<form id="c"><p>${f[0]} and ${f[1].toLowerCase()} are required.</p>${block(skin, rows)}<p><button>Send</button></p></form>`, expect: { '3.3.2': P }, why: 'a sentence before the fields names both as required' };
    },
  },
  // D17: G167 by words.
  'g167-action': {
    reps: 8, title: 'Stay informed', build: (skin, pick) => {
      const label = pick(['Email', 'Email address', 'Phone number', 'Your phone']);
      return { body: `<form id="g"><input name="x" aria-label="${label}"> <button>${pick(ACTIONS)}</button></form><p>Get our weekly updates.</p>`, expect: { '3.3.2': F }, why: 'only a screen-reader name; the button beside it names an action, not the field' };
    },
  },
  'g167-naming': {
    reps: 8, title: 'Checkout', build: (skin, pick) => {
      const [label, btn] = pick([['Promo code', 'Apply promo code'], ['Tracking number', 'Track number'], ['Permit number', 'Look up permit number'], ['ZIP code', 'Find by ZIP code']] as const);
      return { body: `<form id="g"><input name="x" aria-label="${label}"> <button>${btn}</button></form><p>Fees apply at checkout.</p>`, expect: { '3.3.2': P }, why: 'the button names what the field takes (G167)' };
    },
  },
  // D19: phone width and vanishing labels.
  'label-hidden-mobile': {
    reps: 4, title: 'Newsletter', build: (skin, pick) => {
      const f = pick(PEOPLE);
      const rows = f.slice(0, 2).map((t, j) => row(skin, `<label for="q${j}" class="inline">${t}</label>`, `<input id="q${j}" name="q${j}" placeholder="${t}">`));
      return { body: `<form id="n">${block(skin, rows)}<p><button>Send</button></p></form>`, css: ['@media (max-width: 600px) { .inline { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); } }'], expect: { '3.3.2': F }, why: 'labels hidden at a phone width, only placeholders left there' };
    },
  },
  // Precision fix (lead's ruling 2026-11-13): instructions in words no rule was built for, written by a fresh subagent
  // from the criterion text alone. Required fields with no mark, and an instruction inside the form, beside a field, or
  // right before the form: the verdict is the AI check's, never a failure. Neutral text before the form changes nothing.
  'instr-form-wide': {
    reps: 11, title: 'Apply for a card', build: (skin, pick, rep) => {
      const t = FORM_WIDE_REQUIRED[(rep * SKINS.length + SKINS.indexOf(skin)) % FORM_WIDE_REQUIRED.length]!;
      const rows = pick(PEOPLE).slice(0, 2).map((x, j) => row(skin, lab(`q${j}`, x), `<input id="q${j}" name="q${j}" required>`));
      return { body: `<form id="c"><p>${t}</p>${block(skin, rows)}<p><button>Send</button></p></form>`, expect: { '3.3.2': P }, why: `an instruction inside the form: "${t}"` };
    },
  },
  'instr-per-field': {
    reps: 10, title: 'Apply for a card', build: (skin, pick, rep) => {
      const rows = pick(PEOPLE).slice(0, 2).map((x, j) => {
        const t = PER_FIELD_REQUIRED[(rep * SKINS.length * 2 + SKINS.indexOf(skin) * 2 + j) % PER_FIELD_REQUIRED.length]!.replace(/\{field\}/g, x.toLowerCase());
        return row(skin, lab(`q${j}`, x), `<input id="q${j}" name="q${j}" required aria-describedby="h${j}"> <span id="h${j}" class="hint">${t}</span>`);
      });
      return { body: `<form id="c">${block(skin, rows)}<p><button>Send</button></p></form>`, expect: { '3.3.2': P }, why: 'a note under each field in its own words' };
    },
  },
  'instr-before-form': {
    reps: 4, title: 'Apply for a card', build: (skin, pick, rep) => {
      const t = BEFORE_FORM_REQUIRED[(rep * SKINS.length + SKINS.indexOf(skin)) % BEFORE_FORM_REQUIRED.length]!;
      const rows = pick(PEOPLE).slice(0, 2).map((x, j) => row(skin, lab(`q${j}`, x), `<input id="q${j}" name="q${j}" required>`));
      return { body: `<p>${t}</p><form id="c">${block(skin, rows)}<p><button>Send</button></p></form>`, expect: { '3.3.2': P }, why: `an instruction right before the form: "${t}"` };
    },
  },
  'neutral-before-form': {
    reps: 6, title: 'Apply for a card', build: (skin, pick, rep) => {
      const t = NEUTRAL_FORM_TEXT[(rep * SKINS.length + SKINS.indexOf(skin)) % NEUTRAL_FORM_TEXT.length]!;
      const rows = pick(PEOPLE).slice(0, 2).map((x, j) => row(skin, lab(`q${j}`, x), `<input id="q${j}" name="q${j}" required>`));
      return { body: `<p>${t}</p><form id="c">${block(skin, rows)}<p><button>Send</button></p></form>`, expect: { '3.3.2': F }, why: `required fields with nothing saying so; the text before the form says nothing of it: "${t}"` };
    },
  },
  'label-hidden-mobile-button': {
    reps: 4, title: 'Checkout', build: (skin, pick) => {
      const [label, btn] = pick([['Promo code', 'Apply promo code'], ['Permit number', 'Look up permit number'], ['ZIP code', 'Find by ZIP code']] as const);
      return { body: `<form id="n"><label for="q0" class="inline">${label}</label> <input id="q0" name="q0" aria-label="${label}" placeholder="${label}"> <button>${btn}</button></form><p>Fees apply at checkout.</p>`, css: ['@media (max-width: 600px) { .inline { display: none; } }'], expect: { '3.3.2': P }, why: 'the label is hidden at a phone width, but the button beside it names what the field takes (G167; fix round, Sol S2)' };
    },
  },
  'label-vanishing': {
    reps: 4, title: 'Contact', build: (skin, pick) => {
      const f = pick(PEOPLE);
      const rows = f.slice(0, 2).map((t, j) => `<div class="if">${lab(`q${j}`, t)}<input id="q${j}" name="q${j}"></div>`);
      return { body: `<form id="v" novalidate>${rows.join('')}<p><button>Send</button></p></form>`, css: ['.if { position: relative; margin-top: 12px; } .if label { position: absolute; left: 8px; top: 6px; margin: 0; color: #444; }'], init: ["document.querySelectorAll('.if input').forEach(i=>{const l=i.previousElementSibling;const u=()=>{l.style.display=i.value?'none':'';};i.addEventListener('input',u);i.addEventListener('change',u);});"], expect: { '3.3.2': F }, why: 'an in-field label that disappears once people type' };
    },
  },
  'label-floating': {
    reps: 8, title: 'Contact', build: (skin, pick) => {
      const f = pick(PEOPLE);
      const rows = f.slice(0, 2).map((t, j) => `<div class="fl"><input id="q${j}" name="q${j}" placeholder=" ">${lab(`q${j}`, t)}</div>`);
      return { body: `<form id="v">${rows.join('')}<p><button>Send</button></p></form>`, css: ['.fl { position: relative; margin-top: 24px; } .fl label { position: absolute; left: 8px; top: 6px; margin: 0; } .fl input:focus + label, .fl input:not(:placeholder-shown) + label { top: -20px; font-size: 13px; }'], expect: { '3.3.2': P }, why: 'a floating label that moves above the field and stays' };
    },
  },
  'label-css-content': {
    reps: 5, title: 'Contact', build: (skin, pick) => {
      const f = pick(PEOPLE);
      const rows = f.slice(0, 2).map((t, j) => `<p><span class="lbl" data-l="${t}"></span><br><input name="q${j}" aria-label="${t}"></p>`);
      return { body: `<form id="v">${rows.join('')}<p><button>Send</button></p></form>`, css: ['.lbl::before { content: attr(data-l); font-weight: bold; }'], expect: { '3.3.2': P }, why: 'label text drawn by CSS content is seen (3.3.2 clean; 1.3.1 is another matter)' };
    },
  },
  // Ruling Q6.
  'heading-different': {
    reps: 8, title: 'Contact', build: (skin, pick) => {
      const h = pick(['Contact', 'Reach us', 'Your details']);
      return { body: `<form id="h"><section><h2>${h}</h2><p><input type="email" name="e" aria-label="Email" autocomplete="email"> <input type="tel" name="t" aria-label="Phone" autocomplete="tel"></p></section><p><button>Send</button></p></form>`, expect: { '3.3.2': F }, why: 'a heading over two fields that ask different things, nothing visible per field' };
    },
  },
  'heading-one-purpose': {
    reps: 8, title: 'Contact', build: (skin, pick) => {
      const variant = pick(['phone', 'date']);
      const fields = variant === 'phone'
        ? '(<input name="p1" inputmode="numeric" maxlength="3" size="3" aria-label="Area code">) <input name="p2" inputmode="numeric" maxlength="3" size="3" aria-label="Prefix"> - <input name="p3" inputmode="numeric" maxlength="4" size="4" aria-label="Line number">'
        : '<select name="m" aria-label="Month"><option>1</option><option>2</option></select> <select name="d" aria-label="Day"><option>1</option></select> <select name="y" aria-label="Year"><option>2000</option></select>';
      return { body: `<form id="h"><section><h2>${variant === 'phone' ? 'Phone number' : 'Date of birth'}</h2><p>${fields}</p></section><p><button>Send</button></p></form>`, expect: { '3.3.2': P }, why: 'parts of one value under one heading: listed, never failed (ruling Q6)' };
    },
  },
};

// ---- b18-errors (3.3.1, 3.3.3, 4.1.3) -------------------------------------------------------------------------------

const errorKinds: Parameters<typeof generate>[1] = {
  // D9: the only error text is a symbol.
  'validator-symbol': {
    reps: 8, title: 'Request a record', build: (skin, pick) => {
      const sym = pick(['*', '!', '✗', '×']);
      const rows = [row(skin, lab('n', 'Your name'), `<input id="n" name="n" autocomplete="name"> <span id="n-err" style="color:#b00000;visibility:hidden">${sym}</span>`), row(skin, lab('em', 'Email'), `<input id="em" type="email" name="em" autocomplete="email"> <span id="em-err" style="color:#b00000;visibility:hidden">${sym}</span>`)];
      return { body: `<form id="v" novalidate>${block(skin, rows)}<p><button>Send request</button></p><p id="done" role="status"></p></form>`, init: [VALIDATE], expect: { '3.3.1': F, '3.3.3': A, '4.1.3': A }, why: `the only error text is "${sym}" beside each field` };
    },
  },
  'validator-message': {
    reps: 8, title: 'Request a record', build: (skin) => {
      const rows = [row(skin, lab('n', 'Your name'), '<input id="n" name="n" autocomplete="name" aria-describedby="n-err"> <span id="n-err" style="color:#b00000;visibility:hidden">Enter your name</span>'), row(skin, lab('em', 'Email'), '<input id="em" type="email" name="em" autocomplete="email" aria-describedby="em-err"> <span id="em-err" style="color:#b00000;visibility:hidden">Enter an email address like name@example.com</span>')];
      return { body: `<form id="v" novalidate>${block(skin, rows)}<p><button>Send request</button></p><p id="done" role="status"></p></form>`, init: [VALIDATE], expect: { '3.3.1': P, '3.3.3': P, '4.1.3': A }, why: 'a tied message that names the field and the format' };
    },
  },
  // D11: browser and restating messages.
  'pattern-no-title': {
    reps: 4, title: 'Find a permit', build: (skin, pick) => {
      const [label, pat] = pick([['Parcel', '[0-9]{3}-[0-9]{3}'], ['Permit number', '[A-Z]{2}[0-9]{6}'], ['Account ID', '[0-9]{8}']] as const);
      return { body: `<form id="p">${block(skin, [row(skin, lab('pn', 'Your name'), '<input id="pn" name="pn" autocomplete="name" required>'), row(skin, lab('pc', label), `<input id="pc" name="pc" pattern="${pat}" required>`)])}<p><button>Look up</button></p><p id="r" role="status"></p></form>`, init: ["document.getElementById('p').addEventListener('submit',e=>{e.preventDefault();document.getElementById('r').textContent='Record found.';});"], expect: { '3.3.1': A, '3.3.3': F, '4.1.3': A }, why: 'a pattern with no title: the browser says only "Please match the requested format."' };
    },
  },
  'restate-date': {
    reps: 4, title: 'Book a shelter', build: (skin, pick) => {
      const label = pick(['Start date', 'Date of event', 'Reservation date']);
      return { body: `<form id="d" novalidate>${block(skin, [row(skin, lab('nm', 'Your name'), '<input id="nm" name="nm" autocomplete="name">'), row(skin, lab('dt', label), '<input id="dt" name="dt" aria-describedby="dt-e"> <span id="dt-e"></span>')])}<p><button>Book</button></p><p id="r" role="status"></p></form>`, init: [`document.getElementById('d').addEventListener('submit',e=>{e.preventDefault();const v=document.getElementById('dt').value;const ok=/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(v)&&+v.slice(0,2)<=12;document.getElementById('dt-e').textContent=v&&!ok?'Invalid ${label.toLowerCase()}':'';document.getElementById('r').textContent=ok?'Booked.':'';});`], expect: { '3.3.1': A, '3.3.3': F, '4.1.3': A }, why: '"Invalid <date>" for a date typed as text, no format shown anywhere' };
    },
  },
  'pattern-titled': {
    reps: 3, title: 'Find a permit', build: (skin) => ({ body: `<form id="p">${block(skin, [row(skin, lab('pn', 'Your name'), '<input id="pn" name="pn" autocomplete="name" required>'), row(skin, lab('pc', 'Parcel'), '<input id="pc" name="pc" pattern="[0-9]{3}-[0-9]{3}" title="Three digits, a dash, three digits, like 123-456" required>')])}<p><button>Look up</button></p><p id="r" role="status"></p></form>`, init: ["document.getElementById('p').addEventListener('submit',e=>{e.preventDefault();document.getElementById('r').textContent='Record found.';});"], expect: { '3.3.1': A, '3.3.3': P, '4.1.3': A }, why: 'a pattern with a title: the browser shows it' }),
  },
  'restate-hinted': {
    reps: 3, title: 'Book a shelter', build: (skin) => ({ body: `<form id="d" novalidate>${block(skin, [row(skin, lab('nm', 'Your name'), '<input id="nm" name="nm" autocomplete="name">'), row(skin, lab('dt', 'Start date (MM/DD/YYYY)'), '<input id="dt" name="dt" aria-describedby="dt-e"> <span id="dt-e"></span>')])}<p><button>Book</button></p><p id="r" role="status"></p></form>`, init: ["document.getElementById('d').addEventListener('submit',e=>{e.preventDefault();const v=document.getElementById('dt').value;const ok=/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(v)&&+v.slice(0,2)<=12;document.getElementById('dt-e').textContent=v&&!ok?'Invalid start date':'';document.getElementById('r').textContent=ok?'Booked.':'';});"], expect: { '3.3.1': A, '3.3.3': P, '4.1.3': A }, why: 'the field\'s label gives the format next to the message' }),
  },
  'email-valid-message': {
    reps: 3, title: 'Subscribe', build: (skin) => ({ body: `<form id="s" novalidate>${block(skin, [row(skin, lab('nm', 'Your name'), '<input id="nm" name="nm" autocomplete="name">'), row(skin, lab('em', 'Email'), '<input id="em" type="email" name="em" autocomplete="email" aria-describedby="em-e"> <span id="em-e"></span>')])}<p><button>Subscribe</button></p><p id="r" role="status"></p></form>`, init: ["document.getElementById('s').addEventListener('submit',e=>{e.preventDefault();const v=document.getElementById('em').value;const ok=v.includes('@');document.getElementById('em-e').textContent=v&&!ok?'Enter a valid email address':'';document.getElementById('r').textContent=ok?'Subscribed.':'';});"], expect: { '3.3.1': A, '3.3.3': P, '4.1.3': A }, why: '"Enter a valid email address": what is needed is known to everyone' }),
  },
  // D12: statuses after a choice.
  'filter-quiet': {
    reps: 8, title: 'Find a program', build: (skin, pick) => ({ body: FILTER(pick(['Category', 'Activity type', 'Program area']), false), init: [FILTER_JS], expect: { '3.3.1': A, '3.3.3': A, '4.1.3': F }, why: 'a filter rewrites its result count in a plain paragraph' }),
  },
  'filter-live': {
    reps: 4, title: 'Find a program', build: (skin, pick) => ({ body: FILTER(pick(['Category', 'Activity type', 'Program area']), true), init: [FILTER_JS], expect: { '3.3.1': A, '3.3.3': A, '4.1.3': P }, why: 'the same count in a status region the page had' }),
  },
  'choice-hint': {
    reps: 4, title: 'Open an account', build: (skin) => ({ body: `<form id="t">${block(skin, [row(skin, lab('ty', 'Account type'), '<select id="ty" name="ty"><option value="h">Household</option><option value="b">Business</option></select>')])}<p id="bh" hidden>Business accounts are available on weekdays.</p><p><button>Continue</button></p></form>`, init: ["document.getElementById('ty').addEventListener('change',e=>{document.getElementById('bh').hidden=e.target.value!=='b';});"], expect: { '3.3.1': A, '3.3.3': A, '4.1.3': P }, why: 'a hint the choice reveals is content, not a status (look-alike for the choice rule)' }),
  },
  // Precision fix: a format explained inside the form in words no rule was built for (fresh subagent, criterion text).
  'instr-format': {
    reps: 10, title: 'Find a record', build: (skin, pick, rep) => {
      const t = FORMAT_INSTRUCTIONS[(rep * SKINS.length + SKINS.indexOf(skin)) % FORMAT_INSTRUCTIONS.length]!;
      return { body: `<form id="p"><p>${t}</p>${block(skin, [row(skin, lab('pn', 'Your name'), '<input id="pn" name="pn" autocomplete="name" required>'), row(skin, lab('pc', 'Reference number'), '<input id="pc" name="pc" pattern="[A-Z]{2}[0-9]{6}" required>')])}<p><button>Look up</button></p><p id="r" role="status"></p></form>`, init: ["document.getElementById('p').addEventListener('submit',e=>{e.preventDefault();document.getElementById('r').textContent='Record found.';});"], expect: { '3.3.1': A, '3.3.3': P, '4.1.3': A }, why: `the form explains the format: "${t}"` };
    },
  },
  // Fix round (Sol S7, S8, S9, S15).
  'choice-rewrites-content': {
    reps: 4, title: 'Parking permits', build: (skin) => ({ body: `<form id="t">${block(skin, [row(skin, lab('ty', 'Permit type'), '<select id="ty" name="ty" aria-describedby="du"><option value="m">Monthly</option><option value="q">Quarterly</option></select> <span id="du">30 days</span>')])}<p><button>Continue</button></p></form>`, init: ["document.getElementById('ty').addEventListener('change',e=>{document.getElementById('du').textContent=e.target.value==='m'?'30 days':'90 days';});"], expect: { '3.3.1': A, '3.3.3': A, '4.1.3': P }, why: 'the choice rewrites the permit\'s length in its description: content, not a status (Sol S7)' }),
  },
  'validity-hinted': {
    reps: 4, title: 'Find a permit', build: (skin) => ({ body: `<form id="p">${block(skin, [row(skin, lab('pn', 'Your name'), '<input id="pn" name="pn" autocomplete="name" required>'), row(skin, lab('pc', 'Permit number'), '<input id="pc" name="pc" pattern="[A-Z]{2}[0-9]{6}" aria-describedby="ph" required> <span id="ph">Two capital letters and six digits, such as AB123456.</span>')])}<p><button>Look up</button></p><p id="r" role="status"></p></form>`, init: ["const pc=document.getElementById('pc');pc.addEventListener('input',()=>{pc.setCustomValidity(pc.value&&pc.validity.patternMismatch?'Invalid':'');});document.getElementById('p').addEventListener('submit',e=>{e.preventDefault();document.getElementById('r').textContent='Record found.';});"], expect: { '3.3.1': A, '3.3.3': P, '4.1.3': A }, why: 'a generic custom message, the format in a hint tied to the field (Sol S8, ruling Q9)' }),
  },
  'number-range-generic': {
    reps: 4, title: 'Shelter estimate', build: (skin) => ({ body: `<form id="s" novalidate>${block(skin, [row(skin, lab('nm', 'Your name'), '<input id="nm" name="nm" autocomplete="name">'), row(skin, lab('ni', 'Number of nights'), '<input id="ni" name="ni" type="number" min="1" max="12" aria-describedby="ne"> <span id="ne"></span>')])}<p><button>Estimate</button></p><p id="r" role="status"></p></form>`, init: ["document.getElementById('s').addEventListener('submit',e=>{e.preventDefault();const v=document.getElementById('ni').value;const bad=v!==''&&(+v<1||+v>12);document.getElementById('ne').textContent=bad?'Invalid':'';document.getElementById('r').textContent=bad?'':'Estimate ready.';});"], expect: { '3.3.1': A, '3.3.3': F, '4.1.3': A }, why: 'a number past its range gets only "Invalid" (Sol S15)' }),
  },
  'number-range-stated': {
    reps: 3, title: 'Shelter estimate', build: (skin) => ({ body: `<form id="s" novalidate>${block(skin, [row(skin, lab('nm', 'Your name'), '<input id="nm" name="nm" autocomplete="name">'), row(skin, lab('ni', 'Number of nights (1-12)'), '<input id="ni" name="ni" type="number" min="1" max="12" aria-describedby="ne"> <span id="ne"></span>')])}<p><button>Estimate</button></p><p id="r" role="status"></p></form>`, init: ["document.getElementById('s').addEventListener('submit',e=>{e.preventDefault();const v=document.getElementById('ni').value;const bad=v!==''&&(+v<1||+v>12);document.getElementById('ne').textContent=bad?'Invalid':'';document.getElementById('r').textContent=bad?'':'Estimate ready.';});"], expect: { '3.3.1': A, '3.3.3': P, '4.1.3': A }, why: 'the range is in the label next to a generic message (ruling Q9)' }),
  },
  'status-born-empty': {
    reps: 4, title: 'Request a callback', build: (skin) => ({ body: CALLBACK(skin, '<div id="slot"></div>'), init: [SEND("const d=document.createElement('p');d.setAttribute('role','status');document.getElementById('slot').replaceChildren(d);setTimeout(()=>{d.textContent='Your request was saved.';},200);")], expect: { '3.3.1': A, '3.3.3': A, '4.1.3': P }, why: 'a status region created empty, its text written a moment later: not known to be unannounced (Sol S9)' }),
  },
  // D14: one meaning of "announced".
  'status-created': {
    reps: 4, title: 'Request a callback', build: (skin) => ({ body: CALLBACK(skin, ''), init: [SEND("const d=document.createElement('div');d.setAttribute('role','status');d.textContent='Your request was saved.';f.after(d);")], expect: { '3.3.1': A, '3.3.3': A, '4.1.3': F }, why: 'a status region created together with its text' }),
  },
  'status-hidden': {
    reps: 4, title: 'Request a callback', build: (skin) => ({ body: CALLBACK(skin, '<p id="s" role="status" aria-hidden="true"></p>'), init: [SEND("document.getElementById('s').textContent='Your request was saved.';")], expect: { '3.3.1': A, '3.3.3': A, '4.1.3': F }, why: 'a status region hidden from assistive technology' }),
  },
  'alert-inserted': {
    reps: 4, title: 'Request a callback', build: (skin) => ({ body: CALLBACK(skin, ''), init: [SEND("const d=document.createElement('div');d.setAttribute('role','alert');d.textContent='Your request was saved.';f.after(d);")], expect: { '3.3.1': A, '3.3.3': A, '4.1.3': P }, why: 'an alert added with its text is announced' }),
  },
  'status-existing': {
    reps: 4, title: 'Request a callback', build: (skin) => ({ body: CALLBACK(skin, '<p id="s" role="status"></p>'), init: [SEND("document.getElementById('s').textContent='Your request was saved.';")], expect: { '3.3.1': A, '3.3.3': A, '4.1.3': P }, why: 'a status region the page had' }),
  },
};
const VALIDATE = "document.getElementById('v').addEventListener('submit',e=>{e.preventDefault();let bad=false;document.querySelectorAll('#v input').forEach(i=>{const s=document.getElementById(i.id+'-err');const ok=i.value.trim()&&(i.type!=='email'||i.value.includes('@'));s.style.visibility=ok?'hidden':'visible';if(!ok)bad=true;});if(!bad)document.getElementById('done').textContent='Request saved.';});";
const FILTER = (label: string, live: boolean) => `<div class="filters"><label for="cat">${label}</label><select id="cat"><option value="">All</option><option value="pool">Pool</option><option value="art">Art</option></select></div><p id="count"${live ? ' role="status"' : ''}>Showing 4 of 4 programs</p><ul id="list"><li data-c="pool">Swim lessons</li><li data-c="art">Painting</li><li data-c="pool">Water aerobics</li><li data-c="art">Pottery</li></ul>`;
const FILTER_JS = "const s=document.getElementById('cat');s.addEventListener('change',()=>{let n=0;document.querySelectorAll('#list li').forEach(li=>{const on=!s.value||li.dataset.c===s.value;li.hidden=!on;if(on)n++;});document.getElementById('count').textContent='Showing '+n+' of 4 programs';});";
const CALLBACK = (skin: Skin, extra: string) => `<form id="f" novalidate>${block(skin, [row(skin, lab('n', 'Your name'), '<input id="n" name="n" autocomplete="name">'), row(skin, lab('t', 'Topic'), '<input id="t" name="topic">')])}<p><button type="submit">Send request</button></p></form>${extra}`;
const SEND = (body: string) => `const f=document.getElementById('f');f.addEventListener('submit',e=>{e.preventDefault();${body}});`;

// ---- b18-commit (1.3.5, 3.2.2, 3.3.4, 3.3.8) ------------------------------------------------------------------------

const ALL4 = (over: Record<string, Expectation>): Record<string, Expectation> => ({ '1.3.5': A, '3.2.2': A, '3.3.4': A, '3.3.8': A, ...over });
const JUMP = (label: string, after = '', formText = '') => `<form id="j">${formText}<label for="d">${label}</label><select id="d" name="d"><option value="">Choose one</option><option value="/parks">Parks</option><option value="/water">Water</option></select> ${after}</form>`;
const JUMP_JS = "document.getElementById('d').addEventListener('change',e=>{if(e.target.value)location.href=e.target.value;});";
const commitKinds: Parameters<typeof generate>[1] = {
  // D22
  // Fix round (Sol S4, lead's ruling): bank details are listed, never failed (the press is never made to see what it does).
  'pay-bank': { reps: 4, title: 'Pay your bill', build: (skin, pick) => ({ body: BANK(skin, pick(['Submit payment', 'Pay now', 'Pay $84.20']), ''), expect: ALL4({ '3.3.4': A }), why: 'bank details paid on one press: listed for review (Sol S4)' }) },
  'pay-card': { reps: 8, title: 'Pay your bill', build: (skin, pick) => ({ body: CARD(skin, pick(['Pay now', 'Pay $84.20', 'Submit payment']), ''), expect: ALL4({ '3.3.4': F }), why: 'card details paid on one press, no review, box or refund text' }) },
  'pay-card-review-held': { reps: 4, title: 'Pay your bill', build: (skin) => ({ body: CARD(skin, 'Pay now', '<dialog id="rv"><h2>Review your payment</h2><p>Check the amount and the card.</p><button type="button">Confirm payment</button></dialog>'), init: ["document.getElementById('c').addEventListener('submit',e=>{e.preventDefault();document.getElementById('rv').showModal();});"], expect: ALL4({ '3.3.4': P }), why: 'the press opens a review dialog the page holds (Sol S4)' }) },
  'pay-bank-confirm': { reps: 4, title: 'Pay your bill', build: (skin) => ({ body: BANK(skin, 'Submit payment', ' onclick="return confirm(\'Pay $84.20 from this account?\')"'), expect: ALL4({ '3.3.4': P }), why: 'the button asks for a confirmation inline' }) },
  'pay-bank-box': { reps: 4, title: 'Pay your bill', build: (skin) => ({ body: BANK(skin, 'Submit payment', '', '<p><label><input type="checkbox" required> I have reviewed the amount and the account</label></p>'), expect: ALL4({ '3.3.4': P }), why: 'a confirmation check box (G155)' }) },
  'utility-account': { reps: 4, title: 'Pay your bill', build: (skin) => ({ body: `<form id="u">${block(skin, [row(skin, lab('ua', 'Utility account number'), '<input id="ua" name="ua">'), row(skin, lab('am', 'Amount'), '<input id="am" name="am" value="84.20">')])}<p><button>Continue to payment</button></p></form>`, expect: ALL4({ '3.3.4': P }), why: 'no card or bank details; the next step takes them' }) },
  // D23
  // Fix round (Sol S5, S6, lead's ruling): a user-name field that refuses a paste and characters asked by position are
  // listed, never failed; a password field that blocks paste still fails, unless another way to sign in is offered.
  'login-user-paste': { reps: 4, title: 'Sign in', build: (skin, pick) => ({ body: LOGIN(skin, pick(['User name', 'Email', 'Account email']), ' onpaste="return false"', ''), expect: ALL4({ '3.3.8': A }), why: 'the user-name field of a log-in refuses paste: listed (Sol S6)' }) },
  'login-email-checks-paste': { reps: 4, title: 'Sign in', build: (skin) => ({ body: LOGIN(skin, 'Email', '', ''), init: ["document.getElementById('u').addEventListener('paste',e=>{const v=(e.clipboardData.getData('text/plain')||'').trim();if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v))e.preventDefault();});"], expect: ALL4({ '3.3.8': P }), why: 'the email field refuses only a paste that is no email address (Sol S6)' }) },
  'login-password-paste': { reps: 8, title: 'Sign in', build: (skin) => ({ body: LOGIN(skin, 'User name', '', ''), init: ["document.getElementById('pw').addEventListener('paste',e=>e.preventDefault());"], expect: ALL4({ '3.3.8': F }), why: 'the password field blocks paste' }) },
  'login-password-paste-alt': { reps: 4, title: 'Sign in', build: (skin) => ({ body: LOGIN(skin, 'User name', '', '<p><a href="#magic">Email me a sign-in link</a></p>'), init: ["document.getElementById('pw').addEventListener('paste',e=>e.preventDefault());"], expect: ALL4({ '3.3.8': P }), why: 'paste blocked, but another way to sign in is offered (Sol S5)' }) },
  'login-partial': { reps: 4, title: 'Sign in', build: (skin) => ({ body: `<form id="l"><p>Enter characters from your memorable word.</p>${block(skin, [row(skin, lab('u', 'User name'), '<input id="u" name="u" autocomplete="username">'), row(skin, lab('c2', '2nd character'), '<input id="c2" type="password" maxlength="1" size="1">'), row(skin, lab('c5', '5th character'), '<input id="c5" type="password" maxlength="1" size="1">'), row(skin, lab('c7', '7th character'), '<input id="c7" type="password" maxlength="1" size="1">')])}<p><button>Sign in</button></p></form>`, expect: ALL4({ '3.3.8': P }), why: 'characters of a memorable word asked by position: listed for review, never failed (Sol S5)' }) },
  'login-trim': { reps: 4, title: 'Sign in', build: (skin) => ({ body: LOGIN(skin, 'User name', '', ''), init: ["document.getElementById('u').addEventListener('input',e=>{const t=e.target.value.trim();if(t!==e.target.value)e.target.value=t;});"], expect: ALL4({ '3.3.8': P }), why: 'the field trims a paste and keeps the text' }) },
  'login-ok': { reps: 4, title: 'Sign in', build: (skin) => ({ body: LOGIN(skin, 'User name', '', '<p><a href="#magic">Email me a sign-in link</a></p>'), expect: ALL4({ '3.3.8': P }), why: 'paste allowed everywhere' }) },
  // D21
  'dob-parts': { reps: 4, title: 'Enroll a student', build: (skin) => ({ body: `<form id="d">${block(skin, [row(skin, lab('fn', 'Full name'), '<input id="fn" name="fn" autocomplete="name">')])}<fieldset><legend>Date of birth</legend><label for="m">Month</label><select id="m" name="m"><option>1</option><option>2</option></select><label for="dy">Day</label><select id="dy" name="dy"><option>1</option></select><label for="y">Year</label><select id="y" name="y"><option>2000</option></select></fieldset><p><button>Continue</button></p></form>`, expect: ALL4({ '1.3.5': F }), why: 'a date of birth in three lists under its legend, with no bday tokens' }) },
  'owner-qualified': { reps: 4, title: 'Apply', build: (skin, pick) => ({ body: `<form id="o">${block(skin, [row(skin, lab('a', pick(['Applicant first name', 'Your daytime phone', 'Email for receipts'])), '<input id="a" name="a">')])}<p><button>Apply</button></p></form>`, expect: ALL4({ '1.3.5': F }), why: 'a personal field named with an owner word or what it is for, no autocomplete' }) },
  // Fix round (Sol S3, lead's ruling): an email field whose words name no purpose is a review case, never failed.
  'type-email': { reps: 4, title: 'Stay informed', build: (skin) => ({ body: `<form id="t">${block(skin, [row(skin, lab('e', 'Where should we send updates?'), '<input id="e" type="email" name="e">')])}<p><button>Subscribe</button></p></form>`, expect: ALL4({ '1.3.5': P }), why: 'an email field by its type alone: a review case (Sol S3)' }) },
  'emergency-form-email': { reps: 4, title: 'Emergency contact', build: (skin, pick) => ({ body: `<h2>Emergency contact</h2><form id="t" aria-label="Emergency contact">${block(skin, [row(skin, lab('e', pick(['Email address', 'Email', 'Where can notices be sent?'])), '<input id="e" type="email" name="e">')])}<p><button>Save contact</button></p></form>`, expect: ALL4({ '1.3.5': P }), why: 'the form is about an emergency contact: the address is theirs (Sol S3)' }) },
  'pothole-address': { reps: 4, title: 'Report a pothole', build: (skin) => ({ body: `<p>Tell us where the problem is.</p><form id="h" aria-label="Report a pothole"><fieldset><legend>Where is the pothole?</legend>${block(skin, [row(skin, lab('ad', 'Address'), '<input id="ad" name="ad">'), row(skin, lab('cs', 'Nearest cross street'), '<input id="cs" name="cs">')])}</fieldset><p><button>Send report</button></p></form>`, expect: ALL4({ '1.3.5': P }), why: 'the address of a place, not the person\'s' }) },
  'other-party': { reps: 4, title: 'Volunteer', build: (skin, pick) => ({ body: `<form id="v">${block(skin, [row(skin, lab('x', pick(['Your supervisor\'s email', 'Emergency contact phone', 'Reference email'])), `<input id="x" type="${pick(['email', 'tel'])}" name="x">`)])}<p><button>Send</button></p></form>`, expect: ALL4({ '1.3.5': P }), why: 'someone else\'s email or phone' }) },
  // D15
  'jump-silent': { reps: 8, title: 'Departments', build: (skin, pick) => ({ body: JUMP(pick(['Department', 'Go to a department', 'Quick links'])), init: [JUMP_JS], expect: ALL4({ '3.2.2': F }), why: 'a list that navigates on choice, nothing said' }) },
  'jump-advised-label': { reps: 3, title: 'Departments', build: () => ({ body: JUMP('Department (opens its page)'), init: [JUMP_JS], expect: ALL4({ '3.2.2': P }), why: 'the label says choosing opens the page' }) },
  'jump-advised-after': { reps: 3, title: 'Departments', build: () => ({ body: JUMP('Department', '<span>Its page opens as soon as you choose.</span>'), init: [JUMP_JS], expect: ALL4({ '3.2.2': P }), why: 'the text after the list says so' }) },
  'jump-advised-form': { reps: 2, title: 'Departments', build: () => ({ body: JUMP('Department', '', '<p>Selecting a department opens its page.</p>'), init: [JUMP_JS], expect: ALL4({ '3.2.2': P }), why: 'the form\'s instructions say so' }) },
};
const BANK = (skin: Skin, button: string, onclick: string, extra = '') => `<form id="b">${block(skin, [row(skin, lab('r', 'Routing number'), '<input id="r" name="r" inputmode="numeric">'), row(skin, lab('a', 'Bank account number'), '<input id="a" name="a" inputmode="numeric">'), row(skin, lab('am', 'Amount'), '<input id="am" name="am" value="84.20">')])}${extra}<p><button${onclick}>${button}</button></p></form>`;
const CARD = (skin: Skin, button: string, extra: string) => `<form id="c">${block(skin, [row(skin, lab('cn', 'Card number'), '<input id="cn" name="cn" autocomplete="cc-number" inputmode="numeric">'), row(skin, lab('am', 'Amount'), '<input id="am" name="am" value="84.20">')])}<p><button>${button}</button></p></form>${extra}`;
const LOGIN = (skin: Skin, user: string, attr: string, extra: string) => `<form id="l">${block(skin, [row(skin, lab('u', user), `<input id="u" name="u" autocomplete="username"${attr}>`), row(skin, lab('pw', 'Password'), '<input id="pw" type="password" name="pw" autocomplete="current-password">')])}<p><button>Sign in</button></p>${extra}</form>`;

const base = { full: true, read: 'probe' as const, capMs: 120_000 };
export const b18StepsTest: SimTest = { ...base, id: 'b18-steps', criteria: ['3.3.7'], probes: () => [formsProbe], readProbes: ['forms'], cases: stepsCases };
export const b18LabelsTest: SimTest = { ...base, id: 'b18-labels', criteria: ['3.3.2'], probes: () => [formFieldsProbe, formsProbe], readProbes: ['form-fields', 'forms'], cases: (seed) => generate('b18-labels', labelKinds, seed) };
export const b18ErrorsTest: SimTest = { ...base, id: 'b18-errors', criteria: ['3.3.1', '3.3.3', '4.1.3'], probes: () => [formsProbe], readProbes: ['forms'], cases: (seed) => generate('b18-errors', errorKinds, seed) };
export const b18CommitTest: SimTest = { ...base, id: 'b18-commit', criteria: ['1.3.5', '3.2.2', '3.3.4', '3.3.8'], probes: () => [formFieldsProbe, formsProbe], readProbes: ['form-fields', 'forms'], cases: (seed) => generate('b18-commit', commitKinds, seed) };
