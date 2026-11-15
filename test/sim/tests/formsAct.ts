// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Act and watch, forms (act-watch lane, 2026-11-11; probe `forms`, deep). Three decision paths, each with pages
// whose answer is known by construction:
// - forms-status (4.1.3): a form handled in the page answers a filled-in submission with a short sentence (in the
//   form, right after it, or in a toast elsewhere on the page). It fails when nothing tells screen readers: no
//   role=status/alert, no aria-live, focus not moved to it. A form that sends its answers with fetch is out of the
//   engine's reach (it sends nothing): run, listed, not counted. Some pages also carry a notice outside the form
//   that rotates by itself through status-like words (by its text, or by showing one line and hiding the others);
//   it must never be taken for the form's answer. Also passing: the answer in an <output>, and an answer spoken
//   through a separate live region 700 ms after it shows (review r1 F2, F3).
// - forms-identify (3.3.1): an empty or malformed submission is answered with an error message that says nothing
//   about which field is wrong ("Could not update your alerts."), in a toast or above the form, with no field
//   marked: fails. Look-alikes pass: the message names the field, an inline error tied to the field, a message
//   about "all required fields" on a form whose labels mark them, a field marked with text, a message that names
//   the group by its legend, a refusal that is no input error ("You must be signed in"), focus moved to the field.
// - forms-suggest (3.3.3): a value in the wrong format (an e-mail address, a phone number, a web address) that the
//   page detects and marks only by colour, with no text at all: fails (the expected format is known). Look-alikes
//   pass: an error that gives the format, a hint tied to the field, the browser's own validation (for the phone
//   number a pattern, which browsers need to check a phone format, with a title that states the format: the browser
//   shows the title, and a pattern with no title gets only "Please match the requested format."), a page that accepts
//   any value, an untied error beside the field's wrapper in the same words for empty and wrong, an example after the
//   field (review r1 F1). The untitled pattern fails 3.3.3 (batch 18, D11): b18-errors' pattern-no-title covers it.
import { formsProbe } from '../../../src/probes/forms.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'none'];
const CSS = ['label { display: block; margin-top: 10px; } input, select, textarea, button { font: 16px Arial; padding: 4px; border: 2px solid #1b1b1b; } .invalid { border-color: #d00000; } [aria-invalid="true"] { border-color: #d00000; } .err { color: #a00000; } .toast { position: fixed; right: 12px; bottom: 12px; background: #1b1b2e; color: #fff; padding: 8px 12px; max-width: 320px; } .notice { border: 1px solid #555; padding: 6px; }'];

// --- forms-status (4.1.3) -------------------------------------------------------------------------------------

type Where = 'in-form' | 'after-form' | 'toast';
type Announce = 'none' | 'status' | 'alert' | 'polite' | 'focus' | 'server' | 'output' | 'late';
const SUCCESS = [
  'Thanks, your request was received.', 'Your report is ready to review. Check the address before you call.', 'Your preferences are saved.',
  'Subscription confirmed for the routes you chose.', 'We will email you within two business days.',
] as const;

export function statusCase(where: Where, announce: Announce, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `forms-status/${where}/${announce}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const text = SUCCESS[(rep + where.length) % SUCCESS.length]!;
  const attr = announce === 'status' ? ' role="status"' : announce === 'alert' ? ' role="alert"' : announce === 'polite' ? ' aria-live="polite"' : announce === 'focus' ? ' tabindex="-1"' : '';
  // An <output> has the implicit role status; 'late' writes the text at once and speaks it through a separate
  // live region 700 ms later (review r1 F2, F3c).
  const tag = announce === 'output' ? 'output' : 'p';
  const msg = `<${tag} id="msg"${attr}${where === 'toast' ? ' class="toast"' : ''}></${tag}>${announce === 'late' ? '<div id="sr" aria-live="polite" style="position:absolute;left:-9999px"></div>' : ''}`;
  const select = rep % 2 === 0
    ? '<label for="topic">Topic (required)</label><select id="topic" name="topic" required><option value="">Choose one</option><option value="s">Streets</option><option value="p">Parks</option></select>'
    : '<label for="details">Details</label><textarea id="details" name="details" rows="3"></textarea>';
  const form = `<form id="f">
<label for="name">Your name (required)</label><input id="name" name="name" autocomplete="name" required>
<label for="email">Email address (required)</label><input id="email" name="email" type="email" autocomplete="email" required>
${select}
<p><button type="submit">${['Send request', 'Preview', 'Save', 'Submit'][rep % 4]}</button></p>${where === 'in-form' ? msg : ''}</form>${where === 'after-form' ? msg : ''}`;
  const show = `var m = document.getElementById('msg'); m.textContent = ${JSON.stringify(text)};${announce === 'focus' ? ' m.focus();' : ''}${announce === 'late' ? ` setTimeout(function () { document.getElementById('sr').textContent = ${JSON.stringify(text)}; }, 700);` : ''}`;
  const init = [`document.getElementById('f').addEventListener('submit', function (e) { e.preventDefault();
  ${announce === 'server' ? `fetch('/api/request', { method: 'POST', body: new FormData(e.target) }).then(function () { ${show} }, function () { ${show} });` : show} });`];
  const pg = parts('Service request', `<p>Ask the city for a service. We answer on business days.</p>${form}${filler(r, 2)}`, [...CSS], init);
  if (where === 'toast') pg.after.push(`<div class="portal">${msg}</div>`);
  // A notice outside the form that rotates by itself through status-like words (every 1.5 to 3 s), by its text.
  if (rep % 3 === 0) {
    const ms = Math.round(1500 + r() * 1500);
    pg.after.push('<p id="notice" class="notice">Library hours updated</p>');
    pg.init.push(`(function () { var lines = ['Library hours updated', '3 results found for park closures', 'Pool schedule saved for winter', 'Trail work completed early'], n = 0;
  setInterval(function () { n = (n + 1) % lines.length; document.getElementById('notice').textContent = lines[n]; }, ${ms}); })();`);
  }
  // Or by showing one of its lines and hiding the others (a class or `hidden`), every 2 to 6 s (review r1 F3b).
  if (rep % 3 === 1) {
    const ms = Math.round(2000 + r() * 4000);
    const by = rep % 2 ? 'hidden' : 'class';
    pg.after.push(`<div id="rot" class="notice">${['Burn ban: residents must use approved devices only', 'Road closed, please use Main Street', '3 results found for park closures', 'Pool schedule saved for winter'].map((l, k) => `<p${k ? (by === 'hidden' ? ' hidden' : ' class="off"') : ''}>${l}</p>`).join('')}</div>`);
    pg.css.push('#rot .off { display: none; }');
    pg.init.push(`(function () { var ps = document.querySelectorAll('#rot p'), n = 0;
  setInterval(function () { ${by === 'hidden' ? 'ps[n].hidden = true; n = (n + 1) % ps.length; ps[n].hidden = false;' : "ps[n].classList.add('off'); n = (n + 1) % ps.length; ps[n].classList.remove('off');"} }, ${ms}); })();`);
  }
  applyHazard(pg, hazard, r);
  return {
    id, test: 'forms-status', hazard, params: { where, announce, rep },
    site: render(pg),
    expect: { '4.1.3': announce === 'server' ? { verdict: 'any' } : announce === 'none' ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: announce === 'none' ? `the filled-in form answers "${text}" ${where === 'toast' ? 'in a toast elsewhere on the page' : where === 'in-form' ? 'inside the form' : 'right after the form'}, in no live region, and focus stays on the button`
      : announce === 'server' ? 'the form sends with fetch: the engine sends nothing, so what the page answers is out of its reach'
        : announce === 'output' ? 'the answer is written into an <output> (implicit role status)'
          : announce === 'late' ? 'the answer is spoken through a live region 700 ms after it shows'
            : `the answer is ${announce === 'focus' ? 'given focus' : `announced (${attr.trim()})`}`,
  };
}

export function statusCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  const wheres: Where[] = ['in-form', 'after-form', 'toast'];
  let i = 0;
  for (const where of wheres) {
    // 18 failing pages per place, 30 passing (5 of each way to announce), 2 out of reach.
    for (let rep = 0; rep < 18; rep++) out.push(statusCase(where, 'none', rep, HAZARDS[i++ % HAZARDS.length]!, seed));
    for (const announce of ['status', 'alert', 'polite', 'focus', 'output', 'late'] as const) for (let rep = 0; rep < 5; rep++) out.push(statusCase(where, announce, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
    for (let rep = 0; rep < 2; rep++) out.push(statusCase(where, 'server', rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  return out;
}

// --- forms-identify (3.3.1) -----------------------------------------------------------------------------------

type Identify = 'generic' | 'named' | 'tied' | 'collective' | 'marked' | 'legend' | 'signin' | 'focus';
type Place = 'toast' | 'top';
const GENERIC = ['Could not update your alerts.', 'Something went wrong. Try again.', 'Your request could not be sent.', 'Sorry, that did not work. Try again.'] as const;

export function identifyCase(kind: Identify, place: Place, text: number, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `forms-identify/${kind}/${place}/${text}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const message = kind === 'generic' ? GENERIC[text % GENERIC.length]!
    : kind === 'named' ? 'Could not save: enter your email address.'
      : kind === 'collective' ? 'Please complete all required fields.'
        // Names the group by its legend ("Topics"); a refusal that is no input error, shown for any values (review r1 F4).
        : kind === 'legend' ? 'Choose at least one topic.'
          : kind === 'signin' ? 'You must be signed in to update alerts.'
            : GENERIC[text % GENERIC.length]!;
  const inline = kind === 'tied' || kind === 'marked';
  const form = `<form id="f" novalidate>
<label for="email">Email address${kind === 'collective' ? ' (required)' : ''}</label><input id="email" name="email" type="email"${inline ? ' aria-describedby="email-err"' : ''}>${inline ? '<span id="email-err" class="err"></span>' : ''}
<fieldset><legend>Topics</legend><label><input type="checkbox" name="route" value="12"> Library news</label><label><input type="checkbox" name="route" value="24"> Park closures</label>${rep % 2 ? '<label><input type="checkbox" name="route" value="38"> Pool hours</label>' : ''}</fieldset>
<p><button type="submit">Update alerts</button></p></form>`;
  const box = `<p id="msg"${place === 'toast' ? ' class="toast"' : ' class="notice"'}></p>`;
  const init = [`document.getElementById('f').addEventListener('submit', function (e) { e.preventDefault();
  var em = document.getElementById('email'), v = em.value, at = v.indexOf('@'), ok = at > 0 && v.indexOf('.', at) > at + 1;
  document.getElementById('msg').textContent = ok${kind === 'signin' ? ' && false' : ''} ? 'Your alert settings are updated.' : ${JSON.stringify(message)};${kind === 'focus' ? '\n  if (!ok) em.focus();' : ''}
  ${inline ? `document.getElementById('email-err').textContent = ok ? '' : (v ? 'Enter an email address, such as name@example.com' : 'Enter your email address');` : ''}
  ${kind === 'marked' ? "if (ok) em.removeAttribute('aria-invalid'); else em.setAttribute('aria-invalid', 'true');" : ''} });`];
  const pg = parts('City alerts', `${place === 'top' ? box : ''}<p>Choose the topics you want alerts for.</p>${form}${filler(r, 2)}`, [...CSS], init);
  if (place === 'toast') pg.after.push(`<div class="portal">${box}</div>`);
  applyHazard(pg, hazard, r);
  const fails = kind === 'generic';
  return {
    id, test: 'forms-identify', hazard, params: { kind, place, text, rep },
    site: render(pg),
    expect: { '3.3.1': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `an empty or malformed email is answered "${message}" ${place === 'toast' ? 'in a toast' : 'above the form'}: nothing says which field is wrong`
      : {
        named: 'the message names the email address field', tied: 'an inline error tied to the email field says what is wrong', collective: 'the message speaks of the required fields, which the labels mark', marked: 'the email field is marked aria-invalid with a tied error text',
        legend: 'the message names the group of check boxes by its legend', signin: 'the message is no input error: the form refuses any values (the filled-in attempt too)', focus: 'focus moves to the email field, which says the item in error',
      }[kind as Exclude<Identify, 'generic'>],
  };
}

export function identifyCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  // 56 failing pages (two places, four messages, seven each) and 98 passing (seven kinds, fourteen each).
  for (const place of ['toast', 'top'] as const) {
    for (let text = 0; text < GENERIC.length; text++) for (let rep = 0; rep < 7; rep++) out.push(identifyCase('generic', place, text, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  for (const kind of ['named', 'tied', 'collective', 'marked', 'legend', 'signin', 'focus'] as const) {
    for (let rep = 0; rep < 14; rep++) out.push(identifyCase(kind, rep % 2 ? 'toast' : 'top', rep % 4, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  return out;
}

// --- forms-suggest (3.3.3) ------------------------------------------------------------------------------------

type Format = 'email' | 'tel' | 'url';
type Suggest = 'class' | 'aria' | 'style' | 'text' | 'hint' | 'native' | 'lenient' | 'beside' | 'after';
const FORMAT: Record<Format, { label: string; ok: string; example: string }> = {
  email: { label: 'Email address', ok: 'var at = v.indexOf("@"); ok = at > 0 && v.indexOf(".", at) > at + 1;', example: 'name@example.com' },
  tel: { label: 'Phone number', ok: 'ok = /^[0-9 ()+-]{7,}$/.test(v);', example: '541-555-0100' },
  url: { label: 'Your website', ok: 'ok = v.indexOf("://") > 0;', example: 'https://example.org' },
};

export function suggestCase(type: Format, kind: Suggest, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `forms-suggest/${type}/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const fmt = FORMAT[type];
  const tied = kind === 'text' || kind === 'hint';
  const form = `<form id="f"${kind === 'native' ? '' : ' novalidate'}>
<label for="cname">Your name</label><input id="cname" autocomplete="name"${kind === 'native' ? ' required' : ''}>
<label for="fmt">${fmt.label}</label>${kind === 'beside' ? '<div class="ctl">' : ''}<input id="fmt" type="${type}"${kind === 'native' ? ` required${type === 'tel' ? ` pattern="[0-9 +\\-]{7,}" title="Digits, spaces, + or -, at least 7, like ${fmt.example}"` : ''}` : ''}${tied ? ' aria-describedby="fmt-help"' : ''}>${kind === 'hint' ? `<span id="fmt-help">We need it in this form: ${fmt.example}</span>` : kind === 'text' ? '<span id="fmt-help" class="err" role="alert"></span>' : ''}${kind === 'beside' ? '</div><p id="fmt-note" class="err"></p>' : ''}${kind === 'after' ? `<small>For example ${fmt.example}</small>` : ''}
<label for="acct">Permit number</label><input id="acct"${kind === 'native' ? ' required' : ''}>
<p><button type="submit">Apply for a permit</button></p><p id="result" role="status"></p></form>`;
  const mark = kind === 'aria' ? "f.setAttribute('aria-invalid', String(!good));"
    : kind === 'style' ? "f.style.borderColor = good ? '' : '#d00000';"
      : "f.classList.toggle('invalid', !good);";
  const init = [`document.getElementById('f').addEventListener('submit', function (e) { e.preventDefault(); var all = true;
  ['cname', 'fmt', 'acct'].forEach(function (id) { var f = document.getElementById(id), v = f.value.trim(), ok = v !== '';
    if (id === 'fmt' && ok && ${kind === 'lenient' ? 'false' : 'true'}) { ${fmt.ok} }
    var good = ok; ${kind === 'native' ? '' : mark}
    ${kind === 'text' ? `if (id === 'fmt') document.getElementById('fmt-help').textContent = good ? '' : (v ? 'Enter it like ${fmt.example}' : 'Enter your ${fmt.label.toLowerCase()}');` : ''}
    ${kind === 'beside' ? `if (id === 'fmt') document.getElementById('fmt-note').textContent = good ? '' : 'Enter it like ${fmt.example}';` : ''}
    all = all && good; });
  document.getElementById('result').textContent = all ? 'Application received. We will reply by email.' : ''; });`];
  const pg = parts('Block party permit', `<p>Apply for a block party permit.</p>${form}${filler(r, 2)}`, [...CSS], init);
  applyHazard(pg, hazard, r);
  const fails = kind === 'class' || kind === 'aria' || kind === 'style';
  return {
    id, test: 'forms-suggest', hazard, params: { type, kind, rep },
    site: render(pg),
    expect: { '3.3.3': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `a wrong ${type} is detected and marked only by ${kind === 'class' ? 'a class that turns the border red' : kind === 'aria' ? 'aria-invalid and a red border' : 'an inline red border'}; no text says the format, which the page knows`
      : {
        text: 'an error tied to the field gives the format', hint: 'a hint tied to the field gives the format', native: type === 'tel' ? "the browser's own validation shows the field's title, which states the format" : "the browser's own validation says what is expected", lenient: 'the page accepts any value: no error is detected',
        beside: 'an untied error beside the field\'s wrapper gives the format, in the same words for an empty and a wrong value', after: 'an example after the field gives the format',
      }[kind as 'text' | 'hint' | 'native' | 'lenient' | 'beside' | 'after'],
  };
}

export function suggestCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  // 54 failing pages (three formats, three marks, six each) and 90 passing (three formats, six kinds, five each).
  for (const type of ['email', 'tel', 'url'] as const) {
    for (const kind of ['class', 'aria', 'style'] as const) for (let rep = 0; rep < 6; rep++) out.push(suggestCase(type, kind, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
    for (const kind of ['text', 'hint', 'native', 'lenient', 'beside', 'after'] as const) for (let rep = 0; rep < 5; rep++) out.push(suggestCase(type, kind, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  return out;
}

const base = { probes: () => [formsProbe], full: true, read: 'probe' as const, readProbes: ['forms'], capMs: 120_000 };
export const formsStatusTest: SimTest = { ...base, id: 'forms-status', criteria: ['4.1.3'], cases: statusCases };
export const formsIdentifyTest: SimTest = { ...base, id: 'forms-identify', criteria: ['3.3.1'], cases: identifyCases };
export const formsSuggestTest: SimTest = { ...base, id: 'forms-suggest', criteria: ['3.3.3'], cases: suggestCases };
