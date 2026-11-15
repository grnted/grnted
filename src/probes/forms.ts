// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The form probes (Plan 4 Task 4.6): automated tests of every form on a sampled page, with the
// request guard on. Two probes share the in-page agent (`formsPage.ts`); the judging below is pure
// and unit-tested. Engine core: no Node-only imports.
// - `form-fields` (core, read-only apart from a synthetic paste): 1.3.5 (input purpose), 3.3.2
//   (visible labels, required fields), 3.3.4 (payment on one press) and 3.3.8 (paste blocked,
//   CAPTCHAs on log-in forms).
// - `forms` (deep, `--full`; it fills fields and presses buttons): 3.2.2 (on input), 3.3.1 (error
//   identification), 3.3.3 (error suggestion), 3.3.7 (redundant entry) and 4.1.3 (status messages).
// Both look inside embedded frames too. Their evidence (`ProbeRun.data`) feeds the AI forms review
// (`grnted/ai`, check `forms`), which judges meaning only and is never scored.
//
// Safety (Plan 4 rule 1): nothing typed reaches the server.
// - Both probes run with the guard in strict mode (`sendsNothing`): from the moment they start, no
//   request at all leaves the page (top-level navigations, a reload included, are held), until the
//   runner loads a page again; the runner never reuses the page for another probe.
// - The interaction probe also stops fetch, XMLHttpRequest, sendBeacon, form.submit(),
//   requestSubmit's sending and window.open inside the page (formsPage.ts), so a form whose answers
//   would go to the server is reported as not testable, with the reason.
// - Values are synthetic, clearly fake and marked (`TEST_MARK`: "Grntedtest Name",
//   "grntedtest@example.invalid", "555-0100"). Nothing is ever typed into password, one-time code,
//   card or PIN fields (`isSensitiveField`), nor into a form that takes card details; forms that take
//   card details, and buttons that look like they delete, cancel or pay, are never pressed; CAPTCHAs
//   are never solved; a dialog stops the form's test.
import type { FrameLike, ProbeFinding } from '../types.js';
import { pageWords, shootElements } from './evidence.js';
import { sameDocument } from './guard.js';
import { typeText } from './keys.js';
import {
  callFormsAgent, installFormsAgent, FIRST_CHOICE,
  type CollectedMessage, type CollectResult, type FormsAgentCaps, type ObserveResult, type ScannedField, type ScannedForm, type ScannedPage,
} from './formsPage.js';
import { PURPOSE_WORDS, acceptedTokens, judgeAutocomplete, matchInputPurpose, nameWords, normalizeLabel, parseAutocomplete, type InputPurpose, type PurposeMatch } from './inputPurpose.js';
import { mergePlanned, plannedFor } from './plan.js';
import { PROBE_DATA_MAX_CHARS, ProbeNotTestable, type GuardEvent, type PageProbe, type ProbeContext } from './types.js';
import { withoutDownloads } from './pressSafely.js';
import { STATUS_TEXT } from './controls/rules.js';
import { LIVE_REGION_SELECTOR } from './liveRegion.js';

export const FORM_FIELDS_PROBE_ID = 'form-fields';
export const FORM_FIELDS_CRITERIA = ['1.3.1', '1.3.5', '3.3.2', '3.3.4', '3.3.8'] as const;
export const FORMS_PROBE_ID = 'forms';
export const FORMS_CRITERIA = ['3.2.2', '3.3.1', '3.3.2', '3.3.3', '3.3.7', '4.1.3'] as const;
/** At most 5 forms and 60 fields per document (the fields outside any form count as one more group). */
export const FORMS_CAPS: FormsAgentCaps = { maxForms: 5, maxFields: 60, live: LIVE_REGION_SELECTOR };
/** Embedded frames looked into per page (besides the page itself). */
export const FORMS_MAX_FRAMES = 4;
/** Text fields typed into per form for the on-input test. */
export const FORMS_TYPED_PER_FORM = 10;
/** Waits after a change, a submit attempt and a "Next" press (ms). */
export const FORMS_WAITS = { change: 150, submit: 450, step: 400, steady: 1100 } as const;
/** Steps of a multi-step form followed for the redundant-entry test. */
export const FORMS_MAX_STEPS = 3;

/** What the paste test pastes (put back straight away): plainly a test, never a real password or code. */
export const PASTE_TEXT = { password: 'grntedtest paste', code: '000000' } as const;

/** The `not_testable` reason for a form whose error messages only the server produces. */
export const SERVER_ONLY = 'error messages come only from the live server; the form was not submitted to avoid sending data';

// ---------------------------------------------------------------------------------------------
// Evidence for the AI forms review (ProbeRun.data). Field values are never included.

export interface FormFieldEvidence {
  /** Position in the form (0-based). */
  ref: number;
  type: string;
  label: string;
  name: string;
  placeholder: string;
  /** The autocomplete attribute as written ('' when absent). */
  autocomplete: string;
  required: boolean;
  /** Help text tied to the field, and its title attribute (format hints). */
  hint: string;
  /** Its purpose (WCAG 1.3.5) could not be decided by rules: the AI is asked. */
  review: boolean;
  /**
   * Batch 18 (forms lane; evidence for the forms AI checks, data only): a seen label of its own, a required mark the
   * rules recognised, its group's legend, visible text right before and right after it. Absent in data written before.
   */
  visibleLabel?: boolean;
  requiredMark?: boolean;
  legend?: string;
  nearby?: string;
  after?: string;
}

/** Batch 18: a result the rules left undecided, with its reason: what the forms AI checks are asked to judge. */
export interface ListedEvidence {
  criterion: string;
  target: string;
  detail: string;
}

/** One form as the `form-fields` probe saw it (no values). */
export interface FormEvidence {
  /** `<frame>:<form>`: 0 is the page itself, 1… its embedded frames; the form's position in it. */
  key: string;
  /** Field names and types: tells the same form apart on other pages and in the `forms` probe's data. */
  sig: string;
  /** Path of the embedded frame's address ('' on the page itself). */
  frame: string;
  name: string;
  /** Text just before the form. */
  context: string;
  /** Instructions and other visible text inside the form. */
  text: string;
  method: string;
  /** Path of the explicit action ('' when none). */
  action: string;
  login: boolean;
  payment: boolean;
  /** Its fields are not all shown at once and a "Next" button shows more (a form in steps). */
  steps: boolean;
  fields: FormFieldEvidence[];
  buttons: string[];
  checkboxes: string[];
  /** CAPTCHAs and puzzles found by rules (provider or what they ask). */
  captcha: string[];
  /**
   * Batch 18 (evidence for the forms AI checks, data only): the form's own instructions (its text with the fields'
   * labels, hints and buttons taken out), a review or confirmation the page holds unshown, the page's other ways to sign
   * in, and the results the rules left undecided on this form. Absent in data written before.
   */
  instructions?: string[];
  reviewHeld?: string;
  altLogin?: string[];
  listed?: ListedEvidence[];
}

/** `ProbeRun.data` of the `form-fields` probe. Search forms are left out. */
export interface FormsProbeData {
  version: 1;
  forms: FormEvidence[];
}

export interface FormErrorEvidence {
  /** The field's `ref` in the form, -1 when the message belongs to no single field. */
  field: number;
  /** Submitted empty, or with a value in the wrong format in this field. */
  after: 'empty' | 'wrong_format';
  text: string;
  /** The site's own message, or the browser's built-in validation message. */
  source: 'page' | 'browser';
}

/** What the `forms` probe saw when it tried a form's error handling. */
export interface FormAttemptEvidence {
  key: string;
  sig: string;
  /** How the error handling was tested (see the probe's results for the reason when not 'client'). */
  validation: 'client' | 'server' | 'silent' | 'not_tested';
  errors: FormErrorEvidence[];
  /** Steps opened (1 for a single-step form). */
  steps: number;
  /**
   * Batch 18 (evidence for the forms AI checks, data only): fields marked as wrong after an attempt with no text of
   * their own (how), each later step's fields against the earlier answers (labels and declared purposes, never values;
   * where each earlier answer was at that step), and the results the rules left undecided on this form.
   */
  marks?: { field: string; after: 'empty' | 'wrong_format'; how: string }[];
  stepPairs?: StepPairEvidence[];
  listed?: ListedEvidence[];
}

/** Batch 18: one later step of a form against what an earlier step took (for the 3.3.7 sameness check). */
export interface StepPairEvidence {
  step: number;
  /** The later step's own words (its headings, legends and paragraphs). */
  stepText: string;
  /** A control on the page that offers earlier answers ('' when none). */
  reuse: string;
  earlier: { label: string; type: string; autocomplete: string; legend: string; where: string }[];
  later: { label: string; type: string; autocomplete: string; legend: string; hint: string; filled: boolean }[];
}

/** `ProbeRun.data` of the `forms` probe. */
export interface FormsInteractionData {
  version: 1;
  forms: FormAttemptEvidence[];
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested).

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (s: string, n = 80) => `"${clip(s.replace(/\s+/g, ' ').trim(), n)}"`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const TEXT_ONLY = new Set(['text', '']);
const TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'number', 'search', 'textarea', 'date', 'time', 'datetime-local', 'month', 'week', 'password']);
const CHOICE_TYPES = new Set(['select', 'select-multiple', 'checkbox', 'radio']);

/** A short pointer to a field for the report: its label (or name), and the group of a radio button. */
export function fieldTarget(f: Pick<ScannedField, 'label' | 'legend' | 'name' | 'id' | 'placeholder' | 'type'>): string {
  const own = f.label || f.placeholder || f.name || f.id || 'unlabeled field';
  const kind = f.type === 'select' || f.type === 'select-multiple' ? 'drop-down list' : f.type === 'textarea' ? 'text box' : `${f.type} field`;
  return clip(`${f.legend && (f.type === 'radio' || f.type === 'checkbox') ? `${f.legend}: ` : ''}${own} (${kind})`, 160);
}

export function formTarget(f: Pick<ScannedForm, 'name' | 'kind' | 'index'>): string {
  if (f.kind === 'loose') return 'fields outside a form';
  return f.name ? `form ${quote(f.name, 100)}` : `form ${f.index + 1} on the page`;
}

const OTP = /\b(otp|one time (pass)?code|one time password|verification code|confirmation code|sms code|text code|2fa|mfa|totp|passcode|authentication code|auth code|codigo de verificacion|security code sent)\b/;
 /** Password-like fields whatever their type (a text field masked by CSS, "Passcode"): batch 18, 3.3.8. */
const PASSWORDISH = /\b(pass ?word|passcode|pass ?phrase|pwd|contrasena|memorable word)\b/;
/** Bank details (batch 18, 3.3.4): a routing or sort code, an IBAN, a bank account number. Never typed. */
const BANK = /\b(routing( number| no)?|aba( number)?|iban|sort code|swift|bic|bank account( number)?|checking account|savings account|numero de cuenta bancaria)\b/;
/** Card details (and PINs): never typed. */
const CARD = /\b(card ?(number|no|num)|cardno|credit card|debit card|pan|cc ?(num|number|no)|ccnum|cvv2?|cvc2?|csc|cid|security code|expiry|expiration|exp date|card exp|name on (the )?card|card ?holder|pin|security pin)\b/;

/** A field's text for the credential and card rules: words, with hyphens, underscores and camel case broken up. */
function fieldWords(f: Pick<ScannedField, 'label' | 'placeholder' | 'name' | 'id'>): string {
  return normalizeLabel([f.label, f.placeholder, nameWords(f.name), nameWords(f.id)].join(' ').replace(/[-_]+/g, ' '));
}

/**
 * Never typed into: passwords, one-time codes, card details and PINs, by type, autocomplete or the
 * field's words (label, placeholder, name, id). The paste test of 3.3.8 is the only thing that ever
 * puts text in a password or code field, under the strict guard, and puts it back at once.
 */
export function isSensitiveField(f: Pick<ScannedField, 'type' | 'autocomplete' | 'label' | 'placeholder' | 'name' | 'id'>): boolean {
  if (f.type === 'password') return true;
  const token = parseAutocomplete(f.autocomplete).token ?? '';
  if (token === 'one-time-code' || token.startsWith('cc-')) return true;
  const words = fieldWords(f);
  return OTP.test(words) || CARD.test(words) || BANK.test(words) || (PASSWORDISH.test(words) && !CHOICE_TYPES.has(f.type));
}

/** A field for a one-time code (autocomplete one-time-code, or its text says so). */
export function isOtpField(f: ScannedField): boolean {
  if (parseAutocomplete(f.autocomplete).token === 'one-time-code') return true;
  if (f.type === 'password' || CHOICE_TYPES.has(f.type)) return false;
  return OTP.test(fieldWords(f));
}

/** Facts about a form derived from its fields. */
export function formFacts(form: ScannedForm, fields: readonly ScannedField[]) {
  const own = fields.filter((f) => f.form === form.index);
  // Batch 18 (V-AU-11): a text field whose words say password (masked by CSS) is a password field too.
  const passwords = own.filter((f) => f.type === 'password' || (TEXT_ONLY.has(f.type) && PASSWORDISH.test(fieldWords(f)) && !/\b(forgot|reset|hint)\b/.test(fieldWords(f))));
  const payment = !!form.cardFrame || own.some((f) => {
    const t = parseAutocomplete(f.autocomplete).token;
    if (t?.startsWith('cc-')) return true;
    // Batch 18 (V-EP-02): bank details pay as card details do.
    if (!CHOICE_TYPES.has(f.type) && BANK.test(fieldWords(f))) return true;
    const m = matchInputPurpose({ label: f.label, placeholder: f.placeholder, name: f.name, id: f.id, type: f.type });
    return m.kind === 'purpose' && m.purpose === 'cc-number';
  });
  // Batch 18 (V-AU-08): characters of one secret asked by position ("2nd character", "5th character") are one log-in
  // secret, not the several passwords of a sign-up.
  const positional = passwords.filter((p) => POSITION.test(normalizeLabel(`${p.label} ${p.placeholder} ${p.legend}`)));
  const whole = passwords.length - positional.length;
  const signup = whole > 1 || passwords.some((p) =>
    parseAutocomplete(p.autocomplete).token === 'new-password' || /\b(new|create|choose|confirm|re-?enter|repeat|nueva|crear|confirmar)\b/.test(normalizeLabel(`${p.label} ${p.placeholder}`)));
  const otp = payment ? [] : own.filter(isOtpField);
  return { own, passwords, payment, signup, otp, login: ((whole === 1 || (whole === 0 && positional.length > 0)) && !signup) || otp.length > 0 };
}

/**
 * Marks every value the probes type, so a test (or a site owner reading logs) can recognise it.
 * Values are plainly fake; passwords, codes and card details are never typed (see `isSensitiveField`).
 */
export const TEST_MARK = 'grntedtest';

/** Synthetic test values: clearly fake, never real-looking personal data, each holding `TEST_MARK` where the field allows text. */
export function syntheticValue(f: Pick<ScannedField, 'type' | 'label' | 'placeholder' | 'name' | 'id' | 'autocomplete' | 'minLength' | 'maxLength' | 'min' | 'pattern'>, purpose?: InputPurpose): string {
  const token = (parseAutocomplete(f.autocomplete).token as InputPurpose | undefined) ?? purpose;
  const m = TEST_MARK;
  const cap = `${m[0]!.toUpperCase()}${m.slice(1)}`;
  const byPurpose: Partial<Record<string, string>> = {
    email: `${m}@example.invalid`, username: m, name: `${cap} Name`, 'given-name': cap, 'family-name': `${cap}-Family`,
    'additional-name': cap, nickname: cap, organization: `${cap} Organization`, 'organization-title': `${cap} Title`,
    'street-address': `1 ${cap} Street`, 'address-line1': `1 ${cap} Street`, 'address-line2': `${cap} Unit`, 'address-level2': `${cap}ville`,
    'address-level1': cap, 'postal-code': '00000', country: `${cap}land`, 'country-name': `${cap}land`, url: `https://${m}.example.invalid`,
  };
  let v: string | undefined;
  if (token?.startsWith('tel')) v = '555-0100';
  else if (token?.startsWith('bday')) v = f.type === 'date' ? '2000-01-01' : '01/01/2000';
  else if (token) v = byPurpose[token];
  if (v === undefined) {
    switch (f.type) {
      case 'email': v = `${m}@example.invalid`; break;
      case 'tel': v = '555-0100'; break;
      case 'url': v = `https://${m}.example.invalid`; break;
      case 'number': v = f.min && Number.isFinite(Number(f.min)) && Number(f.min) > 1 ? f.min : '1'; break;
      case 'date': v = '2000-01-01'; break;
      case 'time': v = '12:00'; break;
      case 'datetime-local': v = '2000-01-01T12:00'; break;
      case 'month': v = '2000-01'; break;
      case 'week': v = '2000-W01'; break;
      case 'textarea': v = `${cap} message`; break;
      case 'search': v = m; break;
      default: v = /^\[?(\\d|\[0-9\])/.test(f.pattern) ? '00000' : cap;
    }
  }
  if (f.minLength > v.length) v = v.padEnd(f.minLength, 'x');
  if (f.maxLength > 0 && v.length > f.maxLength) v = v.slice(0, f.maxLength);
  return v;
}

const DATE_LIKE = /\b(date|dob|birth|fecha|nacimiento|mm ?\/ ?dd|dd ?\/ ?mm)\b/;

/**
 * A value in the wrong format for a field that expects one (email "a", phone "x", number "abc", a
 * date "31/31/2024", a pattern mismatch, a too-short value); undefined when the field has no format.
 */
export function invalidValue(f: Pick<ScannedField, 'type' | 'label' | 'placeholder' | 'name' | 'pattern' | 'minLength' | 'autocomplete'> & Partial<Pick<ScannedField, 'min' | 'max'>>): string | undefined {
  const token = parseAutocomplete(f.autocomplete).token ?? '';
  if (f.type === 'email' || token === 'email') return TEST_MARK;
  if (f.type === 'tel' || token.startsWith('tel')) return TEST_MARK;
  if (f.type === 'number') {
    // Fix round (Sol S15): letters never reach a number field (the browser drops them); a number past its range does.
    const max = Number(f.max);
    const min = Number(f.min);
    if (f.max && Number.isFinite(max)) return String(Math.floor(max) + Math.max(10, Math.abs(Math.floor(max))));
    if (f.min && Number.isFinite(min)) return String(Math.ceil(min) - Math.max(10, Math.abs(Math.ceil(min))));
    return TEST_MARK;
  }
  if (f.type === 'url' || token === 'url') return TEST_MARK;
  if (f.pattern) return `!!${TEST_MARK}!!`;
  if (f.minLength > 1) return 'g';
  if (f.type === 'text' && DATE_LIKE.test(normalizeLabel(`${f.label} ${f.placeholder} ${f.name}`))) return '31/31/2024';
  return undefined;
}

/**
 * Batch 18 (forms lane): words that say what changing a control does, so a person is advised before using it (3.2.2's
 * own exception: "unless the user has been advised of the behavior before using the component"). Read in the field's
 * own label, description, title, the text right before and after it, and its group's legend.
 */
const ADVISED_OWN = /\b(opens (its|the|a|in|that|this|their|your)\b|will open|takes? you (to|straight)|navigates?|redirects?|jumps? (you )?to|(re)?loads? (the|a|its|that|their|this|new) (page|site|section)|refresh(es)? the page|submits? (automatically|the form|immediately|right away|as soon)|(is|are|will be) (submitted|sent) (automatically|immediately|as soon|when)|automatically|in a new (window|tab)|opens? a new (window|tab)|leaves? (this|the) page|you will be (taken|sent|redirected)|as soon as you (choose|select|pick|change)|se abrir[aá]|abre la p[aá]gina|te lleva|(when|once|after) you (choose|select|pick|change|make a (choice|selection))|as you (type|choose|select|pick|change)|on (selection|change)\b|instantly|immediately|(will )?(take|bring|send) you|updates? (the |this )?(page|list|results|map|table|content|view|calendar)|(page|list|results|map|table|view|calendar) (will )?(updates?|changes?|refresh(es)?|reloads?)|(shows?|displays?) (its|the|that) (page|site)|translat(e|es|ion) (this|the) (page|site))/i;
/** In the form's own instructions: a choice verb and what it does, in one sentence ("Selecting a month opens its agenda"). */
const ADVISED_FORM = /\b(select(ing|ion)?|choos(e|es|ing)|chang(e|es|ing)|pick(s|ing)?|tick(ing)?|check(ing)?)\b[^.!?]{0,80}\b(opens?|takes? you|goes? to|navigates?|redirects?|(re)?loads?|submits?|(is|are) (submitted|sent)|new (window|tab)|automatically|immediately|instantly|updates? (the )?(page|list|results)|translates?)\b/i;

/** The words that advised people of what a change of `field` does, or '' when none. */
export function advisedBy(field: Pick<ScannedField, 'label' | 'hint' | 'title' | 'nearby' | 'legend'> & { after?: string }, form: Pick<ScannedForm, 'text' | 'context'>): string {
  for (const t of [field.label, field.hint, field.title, field.nearby, field.after ?? '', field.legend]) {
    const m = ADVISED_OWN.exec(t || '');
    if (m) return clip(t.replace(/\s+/g, ' ').trim(), 120);
  }
  for (const t of [form.text, form.context]) {
    const m = ADVISED_FORM.exec(t || '');
    if (m) return clip(m[0].replace(/\s+/g, ' ').trim(), 120);
  }
  return '';
}

/** Words that speak of choosing (batch 19): a sentence with one of them, by the control, may say what a choice does. */
const CHOICE_TALK = /\b(choos\w*|choice|select\w*|pick\w*|options?|list|menu|drop-?down)\b/i;
const wordCount = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

/**
 * Batch 19 (precision lane; the forms lane's precision ruling applied to 3.2.2): text by the control that the advice
 * patterns do not classify and that may still advise of what a change does, or ''. A failure never rests on the absence
 * of recognised wording: a label of five words or more (more than a name: "Pick a department to visit its page"), a
 * description or title of four or more, or a sentence of four words or more right after the control or among a real
 * form's own instructions that speaks of choosing ("Your choice goes straight to that page"). A short label ("Meeting
 * month", "Choose a park") and text before the control that says nothing of choosing are no advice.
 */
export function unclassifiedAdvice(field: Pick<ScannedField, 'label' | 'hint' | 'title'> & { after?: string }, form: Pick<ScannedForm, 'text' | 'kind'>): string {
  const clean = (t: string | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
  if (wordCount(clean(field.label)) >= 5) return clip(clean(field.label), 120);
  for (const t of [field.hint, field.title]) if (wordCount(clean(t)) >= 4) return clip(clean(t), 120);
  const after = clean(field.after);
  if (wordCount(after) >= 4 && CHOICE_TALK.test(after)) return clip(after, 120);
  if (form.kind !== 'loose') {
    for (const sentence of clean(form.text).split(/(?<=[.!?])\s+/)) {
      if (wordCount(sentence) >= 4 && CHOICE_TALK.test(sentence) && sentence !== clean(field.label)) return clip(sentence, 120);
    }
  }
  return '';
}

/** What one change of a control did (3.2.2): a failed finding, 'dialog' (stop the form), or null. */
export function judgeOnInput(
  field: ScannedField,
  form: ScannedForm,
  obs: ObserveResult,
  guard: readonly GuardEvent[],
  pageUrl: string,
  action: string,
): ProbeFinding | 'dialog' | null {
  if (guard.some((e) => e.kind === 'dialog')) return 'dialog';
  // Advised beforehand (batch 18): the change of context is what the page said the control does.
  const advice = advisedBy(field, form);
  const unsure = advice ? '' : unclassifiedAdvice(field, form);
  const fail = (what: string): ProbeFinding => (advice
    ? { criterion: '3.2.2', status: 'no_failures_found', target: fieldTarget(field), detail: clip(`${action} ${what}, as the page says beforehand (${quote(advice, 100)})`, 500) }
    : unsure
      ? { criterion: '3.2.2', status: 'not_testable', target: fieldTarget(field), detail: clip(`${action} ${what}; the page says ${quote(unsure, 100)} by it, which may advise people of that beforehand: not decided`, 500) }
      : {
        criterion: '3.2.2', status: 'failed', target: fieldTarget(field),
        detail: clip(`${action} ${what}, with no warning beforehand (a change of context on input)`, 500),
      });
  const nav = guard.find((e) => e.kind === 'navigation' || (e.kind === 'blocked' && e.resourceType === 'document'));
  if (nav) {
    if (nav.url && sameDocument(nav.url, pageUrl)) return fail('started to reload the page; the request guard held it');
    return fail(`started loading another page${nav.url ? ` (${clip(nav.url, 120)})` : ''}; the request guard held it`);
  }
  if (obs.submits.some((s) => s.form === form.index && !s.prevented) || obs.protoSubmits.includes(form.index)) return fail('submitted the form');
  if (obs.opens > 0 || guard.some((e) => e.kind === 'popup')) return fail('opened a new window');
  const path = (u: string) => {
    try { return new URL(u).pathname; } catch { return u; }
  };
  const moved = guard.find((e) => e.kind === 'url-change' && e.url && path(e.url) !== path(pageUrl));
  if (moved) return fail(`changed the page address to ${clip(moved.url!, 120)}`);
  if (obs.active.to !== 'body' && obs.active.form !== form.index) {
    // Into a dialog the choice opened ("Add a new address…"): a person may have asked for it (lead's ruling, Q7).
    if (obs.active.dialog && !advice) {
      return { criterion: '3.2.2', status: 'not_testable', target: fieldTarget(field), detail: clip(`${action} opened a dialog and moved the focus into it${obs.active.label ? ` (${quote(obs.active.label, 60)})` : ''}; whether people expect that from this choice is not known`, 500) };
    }
    return fail(`moved the focus out of the form${obs.active.label ? ` to ${quote(obs.active.label, 60)}` : ''}`);
  }
  return null;
}

/** Requests that carry data by nature: in strict mode, one stopped while the form is tried is the form sending. */
const DATA_REQUESTS = new Set(['fetch', 'xhr', 'ping', 'beacon', 'eventsource']);
/** Files a page loads to show itself (the strict guard stops them too; they are not the form sending). */
const PAGE_FILES = new Set(['stylesheet', 'script', 'image', 'font', 'media', 'texttrack', 'manifest']);

/**
 * The guard events that mean the page tried to send the form to the server: a held navigation, a
 * popup, a stopped non-GET, a stopped request to an action address (not a static file), or a
 * stopped fetch, XHR, beacon or event stream. Strict mode stops everything, so a frame loading (a
 * late map or chat) counts only when this attempt also `submitted` the form (a form aimed at a frame).
 */
export function sentData(events: readonly GuardEvent[], opts: { submitted?: boolean } = {}): boolean {
  return events.some((e) => {
    if (e.kind === 'navigation' || e.kind === 'popup') return true;
    if (e.kind !== 'blocked') return false;
    const type = e.resourceType ?? '';
    if (PAGE_FILES.has(type)) return false;
    if (e.reason === 'method' || e.reason === 'action') return true;
    if (DATA_REQUESTS.has(type)) return true;
    return type === 'document' && !!opts.submitted;
  });
}

/** Field names and types of a form: the same form on another page, or in the other probe's run. */
export function formSig(form: Pick<ScannedForm, 'fields'>, fields: ReadonlyMap<number, Pick<ScannedField, 'type' | 'name' | 'id'>>): string {
  return form.fields.slice(0, 12).map((ref) => {
    const f = fields.get(ref);
    return f ? `${f.type}:${(f.name || f.id).toLowerCase().slice(0, 40)}` : '';
  }).join('|');
}

const GENERIC_ERROR = /^(error|errors|invalid|not valid|wrong|incorrect|invalid (input|value|entry|field|data|format|information)|wrong (input|value|format)|incorrect (input|value|format)|this (field|value) is (invalid|not valid|incorrect)|please correct this( field)?|check this field|valor no valido|invalido|invalida|entrada no valida|formato (no valido|incorrecto)|dato incorrecto|campo invalido)$/;

/** An error message that only says something is wrong, without saying what is expected. */
/** An error message that speaks of the fields as a group: it may point at marks the test cannot see. */
const COLLECTIVE = /\b(all|every|each|the|these|those|required|following|highlighted|marked|missing|empty|some|mandatory)\s+(required\s+|mandatory\s+)?(fields?|boxes|questions|items|entries|information|details|answers)\b|\bfields?\s+(marked|highlighted|in red|below|above|with)\b/i;
/** A search's or a lookup's empty result: an answer, not an input error. */
const NO_RESULT = /\b(no|0|zero)\s+(\w+\s+){0,2}(results?|match(es)?|records?|items?|entries|listings?|accounts?)\b|\b(not|nothing|none)\s+(was\s+|were\s+)?found\b|\bcould\s*n[o’']?t find\b|\bno\s+\w+\s+found\b/i;
/** A field's own words that already give its format: an example, a pattern, an at sign. */
const FORMAT_HINT = /\b(e\.?g\.?|example|format|such as|like|mm|dd|yyyy|digits?|characters?)\b|@|\d{3}/i;
/** What a field of a type expects, for 3.3.3's detail. */
const FORMAT_WORDS: Readonly<Record<string, string>> = {
  email: 'an email address such as name@example.com', tel: 'a phone number', url: 'a web address', number: 'a number', date: 'a date',
};

/** Words that say only that something is wrong, or ask again ("Invalid", "Please enter a valid …"). */
const RESTATE_WORDS = new Set(['invalid', 'incorrect', 'wrong', 'error', 'not', 'valid', 'please', 'enter', 'the', 'this', 'value', 'entry', 'field', 'is', 'was', 'that', 'a', 'an', 'your', 'check', 'correct', 'recognized', 'recognised', 'accepted', 'allowed', 'try', 'again', 'no', 'vlido', 'valido', 'invalido', 'invalida']);
/**
 * Batch 18 (D11; atlas V-ES-03): a message that only says the field's value is wrong, in the field's own words and the
 * words every error uses ("Invalid date", "Parcel number not valid"): it names the field and says nothing of what is
 * expected.
 */
export function restatesOnly(text: string, f: Pick<ScannedField, 'label' | 'placeholder' | 'name'>): boolean {
  const own = new Set((normalizeLabel(`${f.label} ${f.placeholder} ${nameWords(f.name)}`).match(/\p{L}+/gu) ?? []));
  const words = (text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/\p{L}+/gu) ?? []);
  return words.length > 0 && words.some((w) => own.has(w)) && words.every((w) => own.has(w) || RESTATE_WORDS.has(w));
}
/** A field whose value has a form of its own that people cannot guess (a date typed as text, a pattern, a phone number, a number range). */
const formatOwn = (f: Pick<ScannedField, 'type' | 'pattern' | 'label' | 'placeholder' | 'name' | 'min' | 'max'>): boolean =>
  !!f.pattern || f.type === 'tel' || (f.type === 'number' && !!(f.min || f.max)) || (f.type === 'text' && DATE_LIKE.test(normalizeLabel(`${f.label} ${f.placeholder} ${f.name}`)));
/**
 * Precision fix (lead's ruling, 2026-11-13 blind grade): a rule that fails because it did not find recognised wording
 * (a required note, a format hint, an instruction) proves nothing when the form says things it cannot classify. These
 * read the form's own instructions: its visible text with every field's label, legend, placeholder, hint, nearby and
 * after text and every button's name taken out, and the text right before it, as sentences of two words or more.
 */
export function formInstructions(form: Pick<ScannedForm, 'text' | 'context' | 'buttons'>, own: readonly Pick<ScannedField, 'label' | 'legend' | 'placeholder' | 'hint' | 'nearby'>[] = []): string[] {
  const pieces = [...own.flatMap((f) => [f.label, f.legend, f.placeholder, f.hint, f.nearby, (f as { after?: string }).after ?? '', (f as { groupText?: string }).groupText ?? '']), ...(form.buttons ?? [])]
    .map((x) => (x ?? '').replace(/\s+/g, ' ').trim()).filter((x) => x.length >= 2).sort((a, b) => b.length - a.length);
  const sentences = (t: string) => {
    let rest = ` ${(t ?? '').replace(/\s+/g, ' ')} `;
    for (const p of pieces) rest = rest.split(p).join(' | ');
    return rest.split(/[|.!?\n]+/).map((x) => x.trim()).filter((x) => (x.match(/\p{L}{2,}/gu) ?? []).length >= 2);
  };
  return [...sentences(form.text), ...sentences(form.context)];
}
/** The form's own instructions inside it only (`formInstructions` without the text before the form), of three words or more. */
export function formInnerInstructions(form: Pick<ScannedForm, 'text' | 'buttons'>, own: readonly Pick<ScannedField, 'label' | 'legend' | 'placeholder' | 'hint' | 'nearby'>[] = []): string[] {
  return formInstructions({ text: form.text, context: '', buttons: form.buttons }, own).filter((x) => (x.match(/\p{L}{2,}/gu) ?? []).length >= 3);
}
/** Words that may say which fields must be filled in, in any phrasing (precision fix): a sign the test cannot read past. */
const REQUIREMENT_TALK = /\*|\b(requir\w*|mandator\w*|must|needs?|needed|necessar\w*|obligator\w*|compulsor\w*|complet\w*|fill\w*|blank|empty|every|all|each|whole|entire|leave|skip|optional|asterisks?|stars?|starred|marked|bold|essential|obligatori\w*|requerid\w*|necesari\w*|debe\w*|llen\w*|tod[oa]s|cada)\b/i;
/**
 * Precision fix: what may say which fields are required that no rule here reads ("Please complete every question",
 * "You must give a phone number", "Tell us about yourself below"): words of filling in or requirement in the field's own
 * hint, title, legend, group question or the text right after it, or in the text right before the form; and ANY
 * instruction inside the form (a sentence of three words or more that is no field's label, hint or button), whatever its
 * words: an instruction the test cannot classify leaves the verdict to review. '' when none.
 */
export function requirementTalk(f: Pick<ScannedField, 'hint' | 'title' | 'legend' | 'nearby' | 'visibleLabel'> & { after?: string; groupText?: string }, form: Pick<ScannedForm, 'text' | 'context' | 'buttons'> & { lead?: string }, own: readonly Pick<ScannedField, 'label' | 'legend' | 'placeholder' | 'hint' | 'nearby'>[] = []): string {
  // The field's own note (a hint tied to it, its title, text right after it), whatever its words: it may say so.
  for (const t of [f.hint, f.title, f.after ?? '']) if (t && (t.match(/\p{L}{2,}/gu) ?? []).length >= 2) return t;
  for (const t of [f.legend, f.groupText ?? '', f.visibleLabel ? f.nearby : '']) if (t && REQUIREMENT_TALK.test(t)) return t;
  const inner = formInnerInstructions(form, own);
  if (inner.length) return inner[0]!;
  return formInstructions({ text: '', context: `${form.context} | ${form.lead ?? ''}`, buttons: form.buttons }, own).find((x) => REQUIREMENT_TALK.test(x)) ?? '';
}
/** Words that say something of a value's form, in any phrasing: a sign that the form may say what it expects. */
const FORMAT_TALK = /\b(format\w*|e\.?g|for example|such as|digits?|letters?|characters?|capitals?|capital letters|upper ?case|lower ?case|dash(es)?|hyphens?|slash(es)?|mm|dd|yyyy|between \S+ and|minimum|maximum|at least|at most|no more than|followed by|(starts?|ends?|begins?) with|exactly)\b/i;

/**
 * What by the field says what it expects, seen while people correct it (fix round, Sol S8; ruling Q9): a hint tied to
 * it, a title (the browser shows it with a pattern's message), or a format in its label or the text right before or
 * after it, or an example in its placeholder. '' when nothing does.
 */
export function formatShownBy(f: Pick<ScannedField, 'label' | 'hint' | 'title' | 'nearby' | 'placeholder'> & { after?: string }, instructions: readonly string[] = [], inner: readonly string[] = []): string {
  if ((f.hint ?? '').trim()) return `a hint (${quote(f.hint, 60)})`;
  if ((f.title ?? '').trim()) return `a title (${quote(f.title, 60)})`;
  for (const t of [f.label, f.nearby, f.after ?? '']) if (t && (FORMAT_HINT.test(t) || RANGE_HINT.test(t))) return `the text ${quote(t, 60)}`;
  // Precision fix: any text right after the field, words in brackets in its label (other than a required or optional
  // mark), or a form instruction that speaks of a value's form: the page may say what it expects in words no rule reads.
  if (/\p{L}{2,}|\d/u.test(f.after ?? '')) return `the text after it (${quote(f.after ?? '', 60)})`;
  const bracket = /\(([^)]*)\)/.exec(f.label ?? '')?.[1] ?? '';
  if (bracket && !/^\s*(required|optional|obligatori[oa]|opcional|\*)\s*$/i.test(bracket)) return `words in its label (${quote(bracket, 60)})`;
  // Any instruction inside the form (it may say the format in words no rule reads), or one before it that speaks of form.
  if (inner.length) return `the form's own words (${quote(inner[0]!, 60)})`;
  const said = instructions.find((x) => FORMAT_TALK.test(x));
  if (said) return `the form's own words (${quote(said, 60)})`;
  // An example in the placeholder ("e.g. AB123456") said it before typing: precision first, it counts too.
  if (f.placeholder && FORMAT_HINT.test(f.placeholder)) return `an example in its placeholder (${quote(f.placeholder, 40)})`;
  return '';
}
/** A range stated in words or numbers ("1-12", "between 1 and 12", "up to 12", "max 12"). */
const RANGE_HINT = /\d+\s*(-|–|to|and|a)\s*\d+|\b(between|from|up to|at most|at least|maximum|minimum|max|min|no more than|no less than|or (more|less|fewer))\b/i;
/** The browser's own message for a pattern mismatch: it never says the pattern (the title is shown beside it, if any). */
const PATTERN_MESSAGE = /^please match the (requested format|format requested)\.?$/i;

export function isGenericError(text: string): boolean {
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').replace(/\s+/g, ' ');
  return GENERIC_ERROR.test(t);
}

/**
 * Words of an error message (English, with the commonest Spanish, French and German ones). A message shown after
 * a form is sent that has none of them, while no field is marked as wrong, is a confirmation or a result
 * ("Request received", "Your estimate is ready"): a status message, not an error to tie to a field.
 */
const READS_AS_ERROR = new RegExp([
  String.raw`\b(?:errors?|invalid|required|requires|missing|incorrect|wrong|must|cannot|can[’']?t|could not|couldn[’']t|unable|failed|failure|problem|oops|sorry|denied|expired|exceeds?|blank|empty|try again|at least|at most|no more than)\b`,
  String.raw`\bnot (?:valid|allowed|accepted|recogni[sz]ed|found|match|a valid|an? )`,
  String.raw`\bdo(?:es)? not match\b|\bdon[’']t match\b`,
  String.raw`\btoo (?:short|long|many|few|large|small|big|old|young|early|late)\b`,
  String.raw`\bplease (?:enter|provide|select|choose|fill|complete|check|correct|try|review|fix|add|specify|type|give|answer|confirm|include|use)\b`,
  String.raw`^(?:enter|provide|select|choose|fill in|complete|specify|check|confirm|tell us|add|type) (?:a|an|the|your|at least|one|whether|if|how|what|when|where|which)\b`,
  String.raw`\b(?:obligatorio|obligatoria|requerido|requerida|inv[aá]lido|inv[aá]lida|incorrecto|incorrecta|por favor|debe|obligatoire|requis|invalide|erreur|veuillez|erforderlich|ung[uü]ltig|fehler|bitte|pflichtfeld)\b`,
].join('|'), 'i');

/** A message's words are an error's (`READS_AS_ERROR`). */
/**
 * Drops from a form's collected messages the text that changes by itself. Only messages nothing explains
 * are watched (not announced, tied to no field, naming and linking none, and not an error by their words):
 * a countdown, a clock or a blinking notice beside the form keeps changing during the watch
 * (`FORMS_WAITS.steady`), a message of the form stays. Forms whose messages are all explained wait for nothing.
 */
export async function dropSelfChanging(call: <T>(op: string, arg?: unknown) => Promise<T | { gone: true }>, obs: CollectResult): Promise<void> {
  const watch = obs.messages.map((m, i) => (!m.live && !m.focus && !m.assoc.length && !m.names.length && !(m.links ?? []).length && !readsAsError(m.text) ? i : -1)).filter((i) => i >= 0);
  if (!watch.length) return;
  const ok = await call<boolean[]>('steady', { indices: watch, ms: FORMS_WAITS.steady });
  if (!Array.isArray(ok)) return;
  const drop = new Set(watch.filter((_, k) => ok[k] === false));
  if (drop.size) obs.messages = obs.messages.filter((_, i) => !drop.has(i));
}

export function readsAsError(text: string): boolean {
  return READS_AS_ERROR.test(text.replace(/\s+/g, ' ').trim());
}

export type AttemptOutcome = 'client' | 'server' | 'silent' | 'stopped';

/**
 * 3.3.3, no suggestion (act-watch lane, 2026-11-11): a value in a format the field states by its type or purpose
 * (an email address, a phone number, a number, a date) that the page detects as wrong (it marks the field, or
 * finds it invalid without the browser's message showing), while no text at all shows: nothing says what is
 * expected, though the page knows it. A field whose label, placeholder, hint, title or the text before it already
 * gives the format (an example, a pattern, an at sign) says it. Pure.
 */
function noSuggestion(fields: ReadonlyMap<number, ScannedField>, obs: CollectResult, attempt: 'empty' | 'format', formatRefs: ReadonlySet<number>, nativeRefs: ReadonlySet<number>, guard: readonly GuardEvent[] = []): ProbeFinding[] {
  if (attempt !== 'format' || obs.messages.length || stoppedAny(guard)) return [];
  const out: ProbeFinding[] = [];
  for (const ref of formatRefs) {
    const f = fields.get(ref);
    // Absence must be shown (review r1 F1): the words around the field (its row, the label that wraps it, the
    // text after it, what describes it) are those of the first attempt; and none of them gives the format.
    const row = obs.rows?.find((r) => r.ref === ref);
    if (!f || !row?.quiet || nativeRefs.has(ref) || FORMAT_HINT.test(`${f.label} ${f.placeholder} ${f.hint} ${f.title} ${f.nearby} ${row.text}`)) continue;
    const mark = obs.marks.find((mk) => mk.ref === ref);
    if (!mark && !obs.invalid.some((i) => i.ref === ref)) continue;
    out.push({
      criterion: '3.3.3', status: 'failed', target: fieldTarget(f),
      detail: `after a value in the wrong format, the page ${mark ? 'marks' : 'finds'} ${quote(f.label || f.name || 'the field', 60)} as wrong but shows no text at all: nothing says what is expected (${FORMAT_WORDS[f.type] ?? 'the format the field asks for'})`,
    });
  }
  return out;
}

/**
 * Whether a message collected after an empty or wrong-format submit is the form's own answer (batch 17,
 * 2026-11-12). `collect` takes every text that changed in the form's area (up to three levels above the form: often
 * the whole main content) between arming and reading, about half a second. A page that updates something there
 * by itself (a live arrival time in a panel beside the form, a clock, a rotating notice) was read as a message of
 * the form: "the form showed 1 error message (for example “7 min”) that screen readers do not announce". A message
 * is the form's answer when:
 * - no timer the page had running before the attempt wrote it (`timer`: self-updating data is never the answer,
 *   wherever it is and whatever it says); and
 * - it is tied to a field (described-by, a label, the field's name, a link to it), is inside the form, was written
 *   while the submit's own events were dispatched (`direct`), is announced or holds focus (the page presents it
 *   as its answer); or, elsewhere on the page, it reads as an error by its words (an error summary above the form).
 * Anything else changed for a reason this test did not show: it is left out, and a form with nothing else to
 * judge is not testable ("silent"), never failed. Pure.
 */
export function attemptAnswer(m: CollectedMessage): boolean {
  if (m.timer) return false;
  if (m.assoc.length || m.names.length || (m.links ?? []).length) return true;
  if (m.inForm || m.near >= 0 || m.direct || m.live || m.focus) return true;
  return readsAsError(m.text);
}

/** The strict guard stopped a request in the attempt's window, of any kind (a script, a picture, a style sheet: JSONP, a pixel, a chunk): what the page then shows may be its answer to that (review r1 F5). */
export function stoppedAny(guard: readonly GuardEvent[]): boolean {
  return guard.some((e) => e.kind === 'blocked' && e.cause !== 'background');
}

/** Words of four letters or more that are not every form's (`FORM_WORDS`), a plural read as its singular. */
const OWN_WORDS = (text: string): string[] => (text.toLowerCase().match(/\p{L}{4,}/gu) ?? []).filter((w) => !FORM_WORD_SET.has(w)).map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));
/** What a field of a type is called in a message ("e-mail", "phone", "web address"). */
const TYPE_WORDS: Readonly<Record<string, string>> = { email: 'email mail address', tel: 'phone telephone number', url: 'website address link', date: 'date', number: 'number amount', search: 'search' };
const FORM_WORD_SET = new Set(['enter', 'type', 'your', 'please', 'field', 'fields', 'required', 'valid', 'value', 'this', 'that', 'with', 'from', 'have', 'must', 'what', 'here', 'form', 'could', 'would', 'should', 'again', 'there', 'sorry', 'something', 'went', 'wrong', 'error', 'save', 'saved', 'send', 'sent', 'submit']);

/**
 * 3.3.1, the item in error not identified (act-watch lane, 2026-11-11; review r1 F4). Pure. A candidate only: it
 * stands when the same form accepts the filled-in attempt (`formsPass`), which shows the error was about the values
 * typed (not "You must be signed in", "This form is closed", a CAPTCHA or a file it needs). The page answered an
 * empty or wrong-format attempt with an error message (by its words) that is inside the form or that the submit
 * itself wrote, never churned, and names no field: it shares no word with any field's label, legend, name, id or
 * placeholder, is tied to none and links to none. Not when a field is marked, the browser showed a message of its own,
 * the page found a field invalid, focus moved to a field, the form has a CAPTCHA, the guard stopped a request, the
 * message speaks of the fields as a group, or the form has one field or one group of choices.
 */
export function unidentifiedError(form: ScannedForm, fields: ReadonlyMap<number, ScannedField>, obs: CollectResult, guard: readonly GuardEvent[], attempt: 'empty' | 'format'): ProbeFinding | null {
  if (stoppedAny(guard) || obs.net.length || obs.marks.length || obs.invalid.length || form.captcha.length) return null;
  if (obs.focusMoved && obs.active.to === 'field') return null;
  const own = form.fields.map((r) => fields.get(r)).filter((f): f is ScannedField => !!f && f.shown && !f.disabled && !f.readOnly && !f.hiddenFromAll);
  // A group of choices (radio buttons, check boxes with one name) is one item.
  const items = new Set(own.map((f) => ((f.type === 'radio' || f.type === 'checkbox') && f.group ? `g:${f.group}` : `f:${f.ref}`)));
  if (items.size < 2) return null;
  const tied = obs.messages.some((m) => m.assoc.length || m.names.length || (m.links ?? []).length);
  if (tied) return null;
  const errors = obs.messages.filter((m) => readsAsError(m.text) && !m.parts && !NO_RESULT.test(m.text));
  if (!errors.length || errors.some((m) => m.churned || m.timer || m.unsure || !(m.inForm || m.direct) || COLLECTIVE.test(m.text))) return null;
  // A field is named by its label, its group's legend, its name, id or placeholder, what its type or autocomplete
  // purpose is called ("postal code" for a ZIP field): one shared word is enough to leave the message alone.
  const fieldWords = new Set(own.flatMap((f) => OWN_WORDS(`${f.label} ${f.legend} ${f.name.replace(/[-_]+/g, ' ')} ${f.id.replace(/[-_]+/g, ' ')} ${f.placeholder} ${TYPE_WORDS[f.type] ?? ''} ${(PURPOSE_WORDS as Readonly<Record<string, string | undefined>>)[parseAutocomplete(f.autocomplete).token ?? ''] ?? ''} ${parseAutocomplete(f.autocomplete).token?.replace(/-/g, ' ') ?? ''}`)));
  if (errors.some((m) => OWN_WORDS(m.text).some((w) => fieldWords.has(w)))) return null;
  return {
    criterion: '3.3.1', status: 'failed', target: formTarget(form),
    detail: `${attempt === 'empty' ? 'submitted with its fields empty' : 'submitted with a value in the wrong format'}, the form answers ${quote(errors[0]!.text)}: it says something is wrong but not where; it names none of the form's ${items.size} fields, is tied to none, and no field is marked as wrong (the same form takes the values when they are filled in)`,
  };
}

/** Words of a message that asks for something left out ("required", "enter", "missing", "please provide…"). */
const DEMAND = /\b(required|requires|missing|blank|empty|enter|provide|fill(ed)? in|complete|select|choose|please|must|need(ed|s)?|cannot be|can[’']?t be|obligatori[oa]|requerid[oa])\b/i;

/**
 * 3.3.2, required only after sending (batch 18, D8; atlas V-LB-11, -24, -25). Pure. A candidate only: it stands when
 * the same form takes the filled-in attempt (`formsPass`), which shows the demand was about the empty fields. The
 * page answered the empty attempt by marking a field (a style, aria-invalid, an icon), finding it invalid, or with an
 * error that asks for something left out and is tied to the field, names it or links to it; and before anything was
 * sent nothing visible said that field is required: no `required` in its markup (the static rule judges those), no
 * mark in its label, text or legend, no "all fields are required", no sentence of the form that names it as required,
 * and no "(optional)" on the other fields. A message that offers a choice ("email or phone") demands neither field.
 * Log-in, search and one-field forms are left out, as by the static rule.
 */
export function demandedFindings(form: ScannedForm, fields: ReadonlyMap<number, ScannedField>, obs: CollectResult, login: boolean): ProbeFinding[] {
  if (form.search || form.kind === 'loose' || login || form.allRequired) return [];
  const own = form.fields.map((r) => fields.get(r)).filter((f): f is ScannedField => !!f && f.shown && !f.disabled && !f.readOnly && !f.hiddenFromAll);
  const typed = own.filter((f) => TEXTISH.has(f.type) || f.type === 'radio' || f.type === 'checkbox');
  if (typed.length < 2) return [];
  // A message that states the format a field expects ("Enter an email address in the form name@example.test") asks for a
  // valid value, not for the field to be filled: neither it nor the mark that goes with it is a demand (training r1).
  const formatAsked = new Set(obs.messages.filter((m) => FORMAT_HINT.test(m.text)).flatMap((m) => [...m.assoc, ...m.names, ...(m.links ?? [])]));
  const demanded = new Set<number>([...obs.invalid.map((i) => i.ref), ...obs.marks.map((m) => m.ref)]);
  for (const m of obs.messages) {
    if (!readsAsError(m.text) || !DEMAND.test(m.text) || NO_RESULT.test(m.text) || FORMAT_HINT.test(m.text)) continue;
    const named = [...m.assoc, ...m.names, ...(m.links ?? [])];
    if (named.length >= 2 && /\b(or|either|o|ou)\b/i.test(m.text)) continue;
    for (const r of named) demanded.add(r);
  }
  const out: ProbeFinding[] = [];
  const groups = new Set<string>();
  for (const f of typed) {
    if (!demanded.has(f.ref) || formatAsked.has(f.ref) || f.required || f.requiredMark || f.filled || f.type === 'password') continue;
    if (f.type === 'checkbox' && !f.group) continue;
    if (f.type === 'radio' && f.group) {
      if (groups.has(f.group)) continue;
      groups.add(f.group);
      if (/\*|\b(required|obligatori[oa])\b/i.test(f.legend)) continue;
    }
    if (requiredSaid(f, form, typed.filter((o) => o !== f))) continue;
    const said = obs.messages.find((m) => [...m.assoc, ...m.names, ...(m.links ?? [])].includes(f.ref));
    // Precision fix (lead's ruling 2026-11-13): words about filling the form in that no rule here reads may say it.
    const talk = requirementTalk(f, form, own);
    if (talk) {
      out.push({ criterion: '3.3.2', status: 'not_testable', target: fieldTarget(f), detail: `sent empty, the form asks for this field; nothing here reads as saying before that it is required, but the page says ${quote(talk, 80)}, which may: not decided` });
      continue;
    }
    out.push({
      criterion: '3.3.2', status: 'failed', minor: true, target: fieldTarget(f),
      detail: `sent empty, the form ${said ? `asks for this field (${quote(said.text, 80)})` : 'marks this field as missing'}, but nothing visible said it is required before sending: no asterisk or "required" next to it, and no note that all fields are required`,
    });
  }
  return out;
}

export interface AttemptJudgment {
  outcome: AttemptOutcome;
  /** For 'server', 'silent' and 'stopped'. */
  reason?: string;
  findings: ProbeFinding[];
  errors: { ref: number; text: string; source: 'page' | 'browser' }[];
  /** Messages and marks seen (for the no-failure summary). */
  seen: { messages: number; native: number; marks: number };
  /** The 3.3.1 "no field identified" candidate (`unidentifiedError`): it stands only if the form accepts the filled-in attempt. */
  unidentified?: ProbeFinding;
}

/**
 * One submit attempt (empty, or with wrong formats) judged from what the page did. Pure.
 * - A dialog stops the form. A request, a held navigation, an unstopped submit event or a blocked
 *   `form.submit()` means the answers went to the server: 'server' (nothing to judge here).
 * - The browser shows its own messages only for a real submit of a form without `novalidate`, or
 *   when the page calls `reportValidity()`. `invalid` events from a script's `checkValidity()` alone
 *   show nothing: when the page found invalid fields that way and showed nothing at all, 3.3.1 fails.
 * - Nothing at all (no message, mark, shown browser message or request): 'silent'.
 * - Otherwise 'client':
 *   - 3.3.1 failed for an error message next to a field that is neither tied to it (aria-describedby,
 *     aria-errormessage, label) nor names it (an error: a field is marked as wrong or found invalid, or
 *     the message's words are an error's; a confirmation or a result is not), and for a field marked as wrong (red border or
 *     background, an error class, an icon, aria-invalid) with no text about it, unless the browser's
 *     own validation message is shown for it.
 *   - 4.1.3 failed when the page showed messages and none is announced: no live region or alert, no
 *     live region changed, and focus did not move.
 *   - 3.3.3 failed (wrong-format attempt) for a message that only says the value is wrong.
 */
export function judgeAttempt(
  form: ScannedForm,
  fields: ReadonlyMap<number, ScannedField>,
  observed: CollectResult,
  guard: readonly GuardEvent[],
  attempt: 'empty' | 'format',
  formatRefs: ReadonlySet<number> = new Set(),
): AttemptJudgment {
  // Only the form's own answer is judged (`attemptAnswer`): text that changed near the form by itself is not.
  const others = observed.messages.filter((m) => !attemptAnswer(m));
  const obs: CollectResult = others.length ? { ...observed, messages: observed.messages.filter(attemptAnswer) } : observed;
  const seen = { messages: obs.messages.length, native: 0, marks: obs.marks.length };
  if (guard.some((e) => e.kind === 'dialog')) {
    return { outcome: 'stopped', reason: 'the page showed a dialog when the form was submitted, so the test stopped there', findings: [], errors: [], seen };
  }
  const submitted = obs.protoSubmits.includes(form.index) || obs.submits.some((s) => s.form === form.index && !s.prevented);
  const sent = submitted || obs.net.length > 0 || sentData(guard, { submitted: submitted || obs.formGone });
  if (sent) return { outcome: 'server', reason: SERVER_ONLY, findings: [], errors: [], seen };
  if (obs.formGone) {
    return { outcome: 'silent', reason: 'the form was removed (or the page replaced) when it was submitted, so its error messages could not be observed', findings: [], errors: [], seen };
  }
  const submitEvent = obs.submits.some((s) => s.form === form.index);
  // The browser's own messages show for a real submit (a submit button, or no button at all) of a
  // form without novalidate, or when the page asks for them with reportValidity().
  const realSubmit = form.kind === 'form' && !form.noValidate && (!form.submitter || form.submitter.kind === 'submit');
  const nativeShown = obs.reported || realSubmit;
  const nativeRefs = new Set(!nativeShown || submitEvent ? [] : obs.invalid.filter((i) => !i.prevented).map((i) => i.ref));
  seen.native = nativeRefs.size;
  if (!obs.messages.length && !obs.marks.length && !nativeRefs.size) {
    if (!nativeShown && obs.invalid.length) {
      const press = form.submitter ? `pressing ${quote(form.submitter.label, 60)}` : 'submitting the form';
      return {
        outcome: 'client', seen, errors: [],
        findings: [{
          criterion: '3.3.1', status: 'failed', target: formTarget(form),
          detail: `${press} ${attempt === 'empty' ? 'with the required fields empty' : 'with wrong values'} did nothing visible: the page found ${plural(obs.invalid.length, 'field')} not filled in correctly but showed no message saying which or why`,
        }, ...noSuggestion(fields, obs, attempt, formatRefs, nativeRefs, guard)],
      };
    }
    return {
      outcome: 'silent', findings: [], errors: [], seen,
      reason: others.length
        ? `submitting the form showed no message of its own and sent nothing; what changed on the page meanwhile (${quote(others[0]!.text, 40)}) ${others.some((m) => m.timer) ? 'is written by a timer the page runs by itself' : 'is outside the form, is not an error by its words and was not written by the submit'}, so it is not the form's answer, and the form's error handling could not be observed`
        : 'submitting the form showed no message and sent nothing, so its error handling could not be observed',
    };
  }
  const findings: ProbeFinding[] = [];
  const errors: AttemptJudgment['errors'] = [];
  const label = (ref: number) => (fields.get(ref) ? fieldTarget(fields.get(ref)!) : formTarget(form));
  // The form's own instructions (precision fix): words no rule here reads may say what it expects.
  const ownFields = form.fields.map((r) => fields.get(r)).filter((x): x is ScannedField => !!x);
  const said = formInstructions(form, ownFields);
  const inner = formInnerInstructions(form, ownFields);
  // A message tied to a field: by aria-describedby, aria-errormessage or its label, by naming the
  // field, or (an error summary's way) by linking to it.
  const tiedRefs = (m: CollectedMessage) => [...m.assoc, ...m.names, ...(m.links ?? [])];
  const withOwnError = new Set(obs.messages.flatMap(tiedRefs));
  const inError = new Set([...obs.invalid.map((i) => i.ref), ...obs.marks.map((mk) => mk.ref)]);
  /**
   * A page-level summary ("Please fix the details below.") beside the fields' own tied errors is not
   * an untied error: other messages are tied to fields, and the field it sits next to has its own tied
   * message or is not in error. The only message, or one right by a field in error with no tied
   * message of its own, is still that field's untied error.
   */
  const summary = (m: CollectedMessage) => withOwnError.size > 0 && (withOwnError.has(m.near) || !inError.has(m.near));
  // The form is in an error state when a field is marked as wrong or the browser found one invalid. Outside it, a
  // message is an error only by its words: a form that takes the attempt and answers "Request received" next to
  // its fields showed a status message (4.1.3 below still asks that it is announced), not an untied error.
  const errorState = inError.size > 0;
  for (const m of obs.messages) {
    const target = m.assoc[0] ?? m.names[0] ?? m.links?.[0] ?? m.near;
    errors.push({ ref: target, text: m.text, source: 'page' });
    if (m.near >= 0 && !tiedRefs(m).length && !summary(m) && (errorState || readsAsError(m.text))) {
      findings.push({
        criterion: '3.3.1', status: 'failed', target: label(m.near),
        detail: `the error message ${quote(m.text)} is not tied to its field: no aria-describedby or aria-errormessage points at it, it is not part of the field's label, and it does not name the field`,
      });
    }
    const tf = fields.get(target);
    if (attempt === 'format' && formatRefs.has(target) && isGenericError(m.text)) {
      // The field already shows what it expects (a hint tied to it, a title, a format in its label or beside it): the
      // generic message may be enough with it (ruling Q9; fix round, Sol S8): listed, never failed.
      const shownBy = tf ? formatShownBy(tf, said, inner) : '';
      findings.push(shownBy
        ? { criterion: '3.3.3', status: 'not_testable', target: label(target), detail: `after a value in the wrong format, the error message only says ${quote(m.text)}; the field itself shows ${shownBy}, so whether people know what to enter is not decided` }
        : {
          criterion: '3.3.3', status: 'failed', target: label(target),
          detail: `after a value in the wrong format, the error message only says ${quote(m.text)}: it does not say what format is expected`,
        });
    } else if (attempt === 'format' && formatRefs.has(target) && tf && formatOwn(tf) && restatesOnly(m.text, tf) && !formatShownBy(tf, said, inner)) {
      // Batch 18 (D11): "Invalid date" for a date typed as text, with no format shown anywhere by the field.
      findings.push({
        criterion: '3.3.3', status: 'failed', target: label(target),
        detail: `after a value in the wrong format, the error message only says ${quote(m.text)}: it names the field but not the format it expects, and nothing by the field shows it`,
      });
    }
  }
  for (const i of obs.invalid) if (nativeRefs.has(i.ref) && i.message) errors.push({ ref: i.ref, text: i.message, source: 'browser' });
  // Batch 18 (D11; V-ES-04, -05): the browser's own message, as the page set it up. A pattern with no title gets only
  // "Please match the requested format."; a script's setCustomValidity("Invalid") says only that it is wrong.
  if (attempt === 'format') {
    for (const i of obs.invalid) {
      const f = fields.get(i.ref);
      if (!f || !nativeRefs.has(i.ref) || !formatRefs.has(i.ref) || !i.message) continue;
      // Fix round (Sol S8): both branches stand only when nothing by the field shows what it expects (ruling Q9).
      const shownBy = formatShownBy(f, said, inner);
      const patternOnly = PATTERN_MESSAGE.test(i.message.trim()) && !!f.pattern && !shownBy;
      const genericOwn = isGenericError(i.message);
      if (genericOwn && shownBy) {
        findings.push({ criterion: '3.3.3', status: 'not_testable', target: label(i.ref), detail: `after a value in the wrong format, the page has the browser say only ${quote(i.message)}; the field itself shows ${shownBy}, so whether people know what to enter is not decided` });
      } else if (patternOnly || genericOwn) {
        findings.push({
          criterion: '3.3.3', status: 'failed', target: label(i.ref),
          detail: patternOnly
            ? `after a value in the wrong format, the browser can only say ${quote(i.message)}: the field sets a pattern but no title, and nothing by it says what format is expected`
            : `after a value in the wrong format, the page has the browser say only ${quote(i.message)}: it does not say what format is expected`,
        });
      }
    }
  }
  for (const mk of obs.marks) {
    if (nativeRefs.has(mk.ref)) continue;
    const hasText = obs.messages.some((m) => m.assoc.includes(mk.ref) || m.names.includes(mk.ref) || m.near === mk.ref);
    if (hasText) continue;
    // A symbol with no words (batch 18, D9) beside another message the page showed, or on a form whose instructions
    // speak of marks: what the symbol means may be said in words no rule ties to the field (precision fix): listed.
    const talk = mk.symbol && !mk.style && !mk.cls && !mk.aria ? (obs.messages[0]?.text ?? inner[0] ?? said.find((x) => REQUIREMENT_TALK.test(x) || /\bmark/i.test(x)) ?? '') : '';
    if (talk) {
      findings.push({ criterion: '3.3.1', status: 'not_testable', target: label(mk.ref), detail: `after the form was submitted ${attempt === 'empty' ? 'empty' : 'with a wrong value'}, only a symbol appears by the field; the page also says ${quote(talk, 80)}, which may explain it: whether the error is identified in text is not decided` });
      continue;
    }
    const how = mk.icon ? 'an icon' : mk.style ? 'a color change' : mk.cls ? 'a change of style' : 'aria-invalid, with nothing visible';
    findings.push({
      criterion: '3.3.1', status: 'failed', target: label(mk.ref),
      detail: `after the form was submitted ${attempt === 'empty' ? 'empty' : 'with a wrong value'}, the field is marked as wrong only by ${how}: no text says what is wrong`,
    });
  }
  findings.push(...noSuggestion(fields, obs, attempt, formatRefs, nativeRefs, guard));
  const unidentified = findings.some((f) => f.criterion === '3.3.1') || nativeRefs.size ? null : unidentifiedError(form, fields, obs, guard, attempt);
  const pageMessages = obs.messages;
  // A message in a live region that appeared after the attempt began, empty (Sol S9), may be announced: not decided.
  if (pageMessages.length && !pageMessages.some((m) => m.live || m.focus || m.unsure) && !obs.announcements.length && !obs.focusMoved) {
    findings.push({
      criterion: '4.1.3', status: 'failed', target: formTarget(form),
      detail: `the form showed ${plural(pageMessages.length, 'error message')} (for example ${quote(pageMessages[0]!.text)}) that screen readers do not announce: none is in a live region or alert, and focus stayed where it was`,
    });
  }
  return { outcome: 'client', findings, errors: errors.slice(0, 20), seen, ...(unidentified ? { unidentified } : {}) };
}

/** What `collect` also takes from outside a form's area after a submit: an error's words, and a status message's. */
export const OUTSIDE_ERROR = READS_AS_ERROR.source;
export const OUTSIDE_STATUS = `${STATUS_TEXT}|${READS_AS_ERROR.source}`;
/** The longest text read as one message after a filled-in form is sent (longer is content, not a status line). */
export const VALID_MESSAGE_MAX = 250;

/**
 * The filled-in attempt (act-watch lane, 2026-11-11), judged from what the page did. Pure. Every field the test
 * may fill holds a plausible test value and the form is sent; nothing leaves the browser (the guard is strict and
 * the agent stops the page's own requests), so what the page then shows is its own script's answer to the action:
 * - a dialog, a request, a held navigation or a submit the page let through: nothing is judged (`stopped` or
 *   `server`: what the live site answers is not seen);
 * - the form taken away, or nothing shown but sections of content (headings, controls, lists): `silent`;
 * - short messages (at most `VALID_MESSAGE_MAX` characters) and none announced: 4.1.3 fails (a status message,
 *   the success or the result of the action, that screen readers are not told about: no live region or alert
 *   holds it, no live region changed, focus did not move to it);
 * - one announced: 4.1.3 clean for this form.
 */
export type ValidOutcome = AttemptOutcome | 'rejected';

export function judgeValid(form: ScannedForm, obs: CollectResult, guard: readonly GuardEvent[], opts: { late?: boolean } = {}): { outcome: ValidOutcome; reason?: string; findings: ProbeFinding[] } {
  if (guard.some((e) => e.kind === 'dialog')) return { outcome: 'stopped', reason: 'the page showed a dialog when the filled-in form was sent', findings: [] };
  const submitted = obs.protoSubmits.includes(form.index) || obs.submits.some((s) => s.form === form.index && !s.prevented);
  // Any request the guard stopped (review r1 F5: a script, a picture or a style sheet too) counts as sending.
  if (submitted || obs.net.length > 0 || stoppedAny(guard) || sentData(guard, { submitted: submitted || obs.formGone })) {
    return { outcome: 'server', reason: 'the filled-in form goes to the live server, so what the page answers could not be observed (nothing is sent in the test)', findings: [] };
  }
  if (obs.formGone) return { outcome: 'silent', reason: 'the form was taken away when it was sent filled in', findings: [] };
  // The form's answer: only what is in or by the form, or what the submit itself wrote elsewhere (review r1 F3b). A
  // notice in the form's area that changed in the window by itself ("Road closed, please use Main Street") is not.
  // Never what a timer the page had running before the attempt wrote (`timer`: a live value in or by the form).
  const answer = (m: CollectedMessage) => !m.timer && !!(m.inForm || m.direct || m.near >= 0);
  // The page refused the test's values (a field it wants that the test leaves empty, a rule of its own): an error,
  // already judged with the earlier attempts, and no answer to a filled-in form (review r1 F8).
  if (obs.marks.length || obs.invalid.length || obs.messages.some((m) => answer(m) && !m.parts && readsAsError(m.text))) {
    return { outcome: 'rejected', reason: 'the page refused the test values', findings: [] };
  }
  const said = obs.messages.filter((m) => !m.parts && m.text.length <= VALID_MESSAGE_MAX && answer(m));
  if (!said.length) return { outcome: 'silent', reason: 'sending the filled-in form showed no message', findings: [] };
  const target = formTarget(form);
  if (said.some((m) => m.live || m.focus) || obs.announcements.length || obs.focusMoved || opts.late) {
    return { outcome: 'client', findings: [{ criterion: '4.1.3', status: 'no_failures_found', target, detail: `sending the filled-in form showed ${quote(said[0]!.text)}, which screen readers are told about` }] };
  }
  // What also changed while nothing was being submitted, or what a shadow tree may announce: not testable.
  if (said.some((m) => m.churned || m.unsure)) return { outcome: 'silent', reason: 'what the page showed also changes by itself, or may be announced inside a shadow tree', findings: [] };
  const press = form.submitter?.label ? quote(form.submitter.label, 40) : 'the form\'s button';
  return {
    outcome: 'client',
    findings: [{
      criterion: '4.1.3', status: 'failed', target,
      detail: `filled in with test values and sent (nothing left the browser), the form showed ${quote(said[0]!.text)}${said[0]!.outside ? ' elsewhere on the page' : ''}, a status message screen readers are not told about: it is in no live region or alert, and focus stayed on ${press}`,
    }],
  };
}

const STATUS_RE = new RegExp(STATUS_TEXT, 'i');
/**
 * 4.1.3 after a choice (batch 18, D12; atlas V-SM-04): what changing a list, a radio group or a check box wrote that
 * reads as a status (a result count, "no results", "saved"): text the change added or rewrote (never content it
 * revealed, which is a disclosure's), short, the change's own doing (in the form, by a field, or written while the
 * change was dispatched), not churning by itself, and not in a shadow tree. Announced when it is in a live region the
 * page had (or an alert), focus moved, or a live region changed: then clean. Pure.
 */
export function choiceStatus(obs: CollectResult, target: string, action: string): ProbeFinding | null {
  // Fix round (Sol S7, lead's ruling): only the status words the controls test uses (STATUS_TEXT: "N results", "no
  // matches", "saved"…). A short number and a noun ("90 days", "7 parks") is as often content the choice rewrote (the
  // length of the chosen permit) as a result count: whether it is a status is the AI check's to judge, never a rule's.
  const said = obs.messages.filter((m) => (m.kind === 'added' || m.kind === 'text') && m.text.length <= 240 && STATUS_RE.test(m.text)
    && !m.parts && !m.churned && !m.unsure && (m.inForm || m.direct || m.near >= 0));
  if (!said.length) return null;
  if (said.some((m) => m.live || m.focus) || obs.announcements.length || obs.focusMoved) {
    return { criterion: '4.1.3', status: 'no_failures_found', target, detail: `${action} shows ${quote(said[0]!.text)}, which screen readers are told about` };
  }
  return {
    criterion: '4.1.3', status: 'failed', target,
    detail: `${action.charAt(0).toUpperCase()}${action.slice(1)} shows ${quote(said[0]!.text)}, a status message screen readers are not told about: it is in no live region or alert, and focus stays on the field`,
  };
}

/** 1.3.5: fields whose text names a purpose but whose autocomplete does not; ambiguous fields go to the AI. */
export function purposeFindings(page: Pick<ScannedPage, 'forms' | 'fields'>): { findings: ProbeFinding[]; review: Set<number>; matched: number } {
  const findings: ProbeFinding[] = [];
  const review = new Set<number>();
  let matched = 0;
  for (const form of page.forms) {
    const facts = formFacts(form, page.fields);
    for (const f of facts.own) {
      // aria-hidden or inert fields are decoys (anti-spam traps) or a widget's own: nobody fills them in.
      // aria-disabled fields are left out of 1.3.5 (ACT 73f2c2), not out of 3.3.2: people can still fill them in.
      // A search field (labelled by its Search button) asks for no personal data; the form's other fields are checked.
      if (f.disabled || f.ariaDisabled || f.readOnly || f.hiddenFromAll || f.search || (form.kind === 'loose' && !f.shown)) continue;
      if (f.type === 'checkbox' || f.type === 'radio' || isOtpField(f) || /captcha/i.test(`${f.name} ${f.id} ${f.label}`)) continue;
      const m: PurposeMatch = matchInputPurpose({
        label: f.label, placeholder: f.placeholder, name: f.name, id: f.id, type: f.type, payment: facts.payment, newPassword: facts.signup, legend: f.legend,
      });
      if (m.kind === 'ambiguous') review.add(f.ref);
      if (m.kind !== 'purpose') continue;
      // Fix round (Sol S3): the form's own name or the field's group speaks of someone else ("Emergency contact", "Who
      // should we notify?"): whose detail it asks for is not the field's words alone to tell. A review case.
      if (FORM_OTHER.test(normalizeLabel(`${form.name} ${f.legend}`))) { review.add(f.ref); continue; }
      // Batch 18 (L-IP-02): an address of a place (where the problem is, a property, a project site) is not the person's.
      if (/^(street-address|address-line\d|address-level\d|postal-code|country|country-name)$/.test(m.purpose)
        && PLACE_WORDS.test(normalizeLabel(`${f.label} ${f.legend} ${f.nearby} ${form.name} ${form.context}`))) continue;
      matched++;
      const verdict = judgeAutocomplete(m.purpose, f.autocomplete);
      if (verdict === 'ok') continue;
      const what = PURPOSE_WORDS[m.purpose] ?? m.purpose;
      const fix = `autocomplete="${m.purpose}"`;
      // An attribute present but empty (autocomplete="") names no purpose, as a missing one does: said as it is.
      const none = f.autocomplete === null || f.autocomplete === undefined ? 'has no autocomplete attribute' : !f.autocomplete.trim() ? 'has an empty autocomplete attribute' : `autocomplete=${quote(f.autocomplete, 60)} names no purpose`;
      const detail = verdict === 'missing' ? `the field asks for ${what} but ${none}; add ${fix}`
        : verdict === 'off' ? `the field asks for ${what} but autocomplete="off" hides its purpose; use ${fix}`
          : verdict === 'invalid' ? `the field asks for ${what} but autocomplete=${quote(f.autocomplete ?? '', 60)} is not a valid value; use ${fix}`
            : `the field asks for ${what} but autocomplete=${quote(f.autocomplete ?? '', 60)} names another purpose; use ${fix}`;
      findings.push({ criterion: '1.3.5', status: 'failed', target: fieldTarget(f), detail });
    }
  }
  return { findings, review, matched };
}

/**
 * Fix round (Sol S3): a form or group named for someone other than the person filling it in (an emergency contact, a
 * reference, a landlord). Parents, guardians and students are left out: the person filling in a school form is often
 * the parent, and their own details are then theirs.
 */
const FORM_OTHER = /\b(emergency|emergencia|next of kin|references?|referees?|spouse|landlord|employer|supervisor|witness(es)?|beneficiar(y|ies)|recipients?|nominees?|caregiver|physician|doctor|authori[sz]ed (pick ?up|users?|contacts?)|(alternate|secondary|additional|other) contacts?|co ?applicant|co ?signer)\b/;
/** Batch 18 (L-IP-02): the words of an address that is a place, not the person's (the inputPurpose rule's twin). */
const PLACE_WORDS = /\b(where|location|incident|problem|issue|property|project|site|nearest|cross street|intersection|pothole|streetlight|event|venue|lugar|ubicacion)\b/;

const PAY_BUTTON = /\b(pay|purchase|buy|place (my |your )?order|complete (my |your )?(order|purchase|payment)|donate|submit payment|confirm payment|pagar|comprar|donar)\b/i;
const CONFIRM_BOX = /\b(confirm|i have (checked|reviewed|read)|review(ed)?|correct|accurate|verify|confirmo|he revisado|correctos?)\b/i;
const REVERSIBLE = /\b(cancel|refund|undo|change (your|my) (order|booking|donation)|reembolso|cancelar|devolucion|devoluciones)\b/i;

/**
 * 3.3.4 (rules part): a form that takes card details and pays on one press, with no review step, no
 * confirmation checkbox and no stated way to cancel or get a refund. Other legal, financial and
 * data-changing forms are judged by the AI review (their purpose needs reading).
 */
export function preventionFindings(page: Pick<ScannedPage, 'forms' | 'fields'>): { findings: ProbeFinding[]; candidates: number } {
  const out: ProbeFinding[] = [];
  let candidates = 0;
  for (const form of page.forms) {
    if (form.search || form.kind === 'loose') continue;
    const facts = formFacts(form, page.fields);
    if (facts.login && !facts.payment) continue;
    candidates++;
    if (!facts.payment || !form.submitter || !PAY_BUTTON.test(form.submitter.label)) continue;
    const boxes = facts.own.filter((f) => f.type === 'checkbox').map((f) => f.label);
    const around = normalizeLabel(`${form.text} ${form.context}`);
    if (boxes.some((b) => CONFIRM_BOX.test(b)) || form.next || REVERSIBLE.test(around) || form.confirmsInline) continue;
    // Fix round (Sol S4, lead's ruling): the test never presses a pay button, so what the press does is never seen. A
    // script may open a review on it (a dialog the page holds, a summary it renders): bank details (a newer, wider rule)
    // and a page that holds a review or confirmation it has not shown yet are evidence for the AI check, not a failure.
    const card = facts.own.some((f) => parseAutocomplete(f.autocomplete).token?.startsWith('cc-') || CARD.test(fieldWords(f))) || !!form.cardFrame;
    const review = form.reviewHeld ?? '';
    if (!card || review) {
      out.push({
        criterion: '3.3.4', status: 'not_testable', target: formTarget(form),
        detail: `the form takes ${card ? 'card' : 'bank account'} details and pays when ${quote(form.submitter.label, 60)} is pressed, with no review step, confirmation checkbox or stated way to cancel shown before it${review ? `; the page holds a ${quote(review, 60)} it has not shown yet` : ''}; whether pressing it pays at once is not known (the test never presses a pay button)`,
      });
      continue;
    }
    out.push({
      criterion: '3.3.4', status: 'failed', target: formTarget(form),
      detail: `the form takes card details and pays when ${quote(form.submitter.label, 60)} is pressed, with no review step, no confirmation checkbox and no stated way to cancel or get a refund`,
    });
  }
  return { findings: out, candidates };
}

/**
 * 3.3.8: paste blocked in a log-in password or code field fails; so does a CAPTCHA that asks people
 * to copy characters, solve a sum or a puzzle on a log-in form with no other way to sign in (an audio
 * version does not count: it also asks people to copy characters). CAPTCHAs that only ask to
 * recognise objects or tick a box (reCAPTCHA, hCaptcha, Turnstile, Friendly Captcha) are allowed at
 * Level AA. Sign-up and change-password forms are not log-in steps: what they block is recorded only.
 */
export function authFindings(
  page: Pick<ScannedPage, 'forms' | 'fields' | 'altLogin'>,
  paste: ReadonlyMap<number, { blocked: boolean; via: string }>,
): { findings: ProbeFinding[]; auth: number } {
  const out: ProbeFinding[] = [];
  const auth = page.forms.map((form) => ({ form, facts: formFacts(form, page.fields) })).filter(({ facts }) => facts.passwords.length || facts.otp.length);
  if (!auth.length) return { findings: [], auth: 0 };
  const tough = (form: ScannedForm) => form.captcha.filter((c) => c.kind !== 'widget');
  const plainLogin = auth.some(({ form, facts }) => facts.login && !tough(form).length);
  for (const { form, facts } of auth) {
    // Batch 18 (V-AU-03, -10): every text field of a log-in form (a user name, an email, a security answer) too.
    const others = facts.login ? facts.own.filter((o) => !facts.passwords.includes(o) && !facts.otp.includes(o) && paste.has(o.ref)) : [];
    for (const f of [...facts.passwords, ...facts.otp, ...others]) {
      const r = paste.get(f.ref);
      if (r?.blocked) {
        const how = r.via === 'cleared' ? 'the page empties the field after a paste' : 'the page stops the paste';
        const secret = facts.passwords.includes(f) || facts.otp.includes(f);
        // Fix round (Sol S5, S6): a user name or email field may refuse what it takes for malformed (a check of the
        // pasted text, not a block of pasting), and a page that offers another way to sign in meets the criterion's
        // own alternative: both are listed, never failed.
        const alt = page.altLogin.length ? `another way to sign in is offered (${quote(page.altLogin[0]!, 60)})` : '';
        out.push(!facts.login
          ? { criterion: '3.3.8', status: 'no_failures_found', target: fieldTarget(f), detail: `pasting is blocked here (${how}); this is a sign-up or change-password form, not a log-in step` }
          : !secret
            ? { criterion: '3.3.8', status: 'not_testable', target: fieldTarget(f), detail: `pasting a test value into this log-in field did not keep it (${how}); whether the page blocks pasting or only refuses that value is not known` }
            : alt
              ? { criterion: '3.3.8', status: 'not_testable', target: fieldTarget(f), detail: `pasting into this ${facts.passwords.includes(f) ? 'password' : 'code'} field is blocked (${how}), but ${alt}; whether that way needs no test of memory is not decided` }
              : { criterion: '3.3.8', status: 'failed', target: fieldTarget(f), detail: `pasting into this ${facts.passwords.includes(f) ? 'password' : 'code'} field is blocked (${how}), so people cannot use a password manager or paste ${facts.otp.includes(f) ? 'a code' : 'what they saved'}` });
      }
      if (f.type === 'password' && parseAutocomplete(f.autocomplete).none && /\boff\b/i.test(f.autocomplete ?? '')) {
        out.push({ criterion: '3.3.8', status: 'no_failures_found', target: fieldTarget(f), detail: 'autocomplete="off" on the password field may stop password managers from filling it in' });
      }
    }
    if (!facts.login) continue;
    // Batch 18 (V-AU-08): characters of a secret asked for by position ("Enter characters 2, 5 and 7 of your memorable
    // word"): a test of memory and counting that no password manager can fill in.
    const partial = facts.own.filter((o) => POSITION.test(normalizeLabel(`${o.label} ${o.placeholder}`)) || POSITION.test(normalizeLabel(o.legend)));
    // Fix round (Sol S5, lead's ruling): whether that is a cognitive function test with no alternative (another log-in
    // on the page, a link to sign in another way, a mechanism that fills it in) is a judgement: evidence for the AI
    // check, listed, never failed by rule.
    if (partial.length && SECRET.test(normalizeLabel(`${form.text} ${form.context} ${partial.map((o) => `${o.label} ${o.legend}`).join(' ')}`))) {
      const other = page.altLogin.length ? `; another way to sign in is offered (${quote(page.altLogin[0]!, 60)})` : auth.some((a) => a.form !== form && a.facts.login) ? '; another log-in form is on the page' : '';
      out.push({
        criterion: '3.3.8', status: 'not_testable', target: formTarget(form),
        detail: `the log-in asks for characters of a secret by their position (${quote(partial[0]!.label || partial[0]!.legend, 60)})${other}; whether people have another way to sign in without recalling and counting is not decided`,
      });
    }
    for (const c of form.captcha) {
      if (c.kind === 'widget') {
        out.push({ criterion: '3.3.8', status: 'no_failures_found', target: formTarget(form), detail: `the log-in uses ${c.provider}, which asks at most to recognize objects or tick a box; WCAG 2.2 allows that at Level AA` });
        continue;
      }
      const other = page.altLogin.length ? `another way to sign in is offered (${quote(page.altLogin[0]!, 60)})` : plainLogin && auth.length > 1 ? 'another log-in form on the page has no such test' : '';
      out.push(other
        ? { criterion: '3.3.8', status: 'no_failures_found', target: formTarget(form), detail: `the log-in asks for ${c.detail}, but ${other}` }
        : {
          criterion: '3.3.8', status: 'failed', target: formTarget(form),
          detail: `the log-in asks for ${c.detail}: a test of memory, copying or puzzle-solving with no other way to sign in (an audio version does not count, it also asks people to copy characters)`,
        });
    }
  }
  return { findings: out, auth: auth.length };
}

const TEXTISH = new Set([...TEXT_TYPES, 'select', 'select-multiple']);
/** A character or digit asked for by its position (batch 18, 3.3.8). */
const POSITION = /\b(\d+(st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+(character|letter|digit|caracter)s?\b|\b(character|letter|digit|caracter)\s+(no\.?\s*)?\d+\b/;
const SECRET = /\b(pass ?word|passcode|pin|memorable|secret|security (word|phrase)|contrasena)\b/;

/**
 * 3.3.2 (labels or instructions), from what is visible:
 * - a field people meet (in sight, or out of sight but in the Tab order or shown by a disclosure: judged as
 *   it looks when shown) whose only label is its placeholder (it disappears as soon as people type), or
 *   that has no visible label at all (only aria-label or title, which sighted people do not see), and
 *   no visible text right before it, fails. Search forms are left out, and so is a field next to a button
 *   named Search: the button labels it (G167); "Go" or an unnamed icon does not. A select whose shown
 *   text says what to choose ("Select Language", or a language picker showing a language) is labelled by
 *   it; its value or a disabled option says nothing. Fields out of sight and out of reach (a closed
 *   date picker's pop-up) are not judged. HTML-disabled or inert fields are not judged; aria-disabled ones are.
 * - in a form of two or more fields (not a log-in), a required field with nothing visible saying so
 *   (an asterisk or "required" in its label, text or hint, or "All fields are required") fails, unless
 *   it already holds a real value (a prefilled date or time, a number or e-mail that passes its own
 *   constraints, a chosen option): "MM/DD/YYYY" typed into a text field is not a value.
 * Returns the findings, the field each one is about (`refs[i]` for `findings[i]`) and how many fields were checked.
 */
/**
 * Option labels that answer a question without saying what it is: every option is a bare answer such as Yes,
 * No, Agree, Never, a rating word or a number. Options that name things ("By e-mail", "Spanish") say enough.
 */
const BARE_ANSWER = /^(?:yes|no|y|n|maybe|not sure|unsure|don'?t know|true|false|(?:strongly |somewhat )?(?:agree|disagree)|neutral|neither|other|none|n\/a|not applicable|s[ií]|ok|on|off|always|never|sometimes|often|rarely|usually|poor|fair|good|very good|excellent|bad|low|medium|high|\d{1,2})$/i;

export function unaskedOptions(options: readonly string[]): boolean {
  const texts = options.map((o) => o.replace(/[\s\u00a0]+/g, ' ').replace(/[.:!?*]+$/, '').trim()).filter(Boolean);
  return texts.length >= 2 && texts.length === options.length && texts.every((t) => BARE_ANSWER.test(t));
}

/**
 * 1.3.1 (F111): a field with visible label text right before it (or right after a check box or radio button) that
 * is not tied to it, so the field has no name at all for screen readers (not even a placeholder or title). Search
 * fields their button labels (G167) are left to 4.1.2.
 */
export function unassociatedLabelFindings(page: Pick<ScannedPage, 'forms' | 'fields'>): { findings: ProbeFinding[]; refs: number[]; checked: number } {
  const out: ProbeFinding[] = [];
  const refs: number[] = [];
  let checked = 0;
  for (const form of page.forms) {
    const facts = formFacts(form, page.fields);
    for (const f of facts.own) {
      if (!f.shown || f.seen === false || f.disabled || f.type === 'hidden' || f.hiddenFromAll) continue;
      checked++;
      if (f.label || f.placeholder || f.search || !f.nearby || !/[\p{L}\p{N}]{2}/u.test(f.nearby)) continue;
      refs.push(f.ref);
      out.push({
        criterion: '1.3.1', status: 'failed', target: fieldTarget(f),
        detail: `the text ${quote(f.nearby, 60)} is shown as this field's label but is not tied to it, so screen readers announce the field with no name; make it the field's <label>`,
      });
    }
  }
  return { findings: out, refs, checked };
}

/** Where `axName` puts the field it asks the accessibility tree about. */
const AX_KEY = '__grntedAxField';

/**
 * The browser's computed accessible name of one field (Chromium's accessibility tree through CDP), or undefined when
 * it cannot be read (no CDP session, the field gone, a call that failed). Never throws.
 */
async function axName(ctx: ProbeContext, doc: FormDoc, ref: number): Promise<string | undefined> {
  const cdp = await ctx.cdp?.().catch(() => undefined);
  if (!cdp) return undefined;
  try {
    // Read as the scan judged it: closed <details> around the field are opened while the tree is read.
    await doc.call('disclose', { ref });
    if ((await doc.call<boolean>('expose', { ref, key: AX_KEY })) !== true) return undefined;
    const ev = (await cdp.send('Runtime.evaluate', { expression: `window[${JSON.stringify(AX_KEY)}] && window[${JSON.stringify(AX_KEY)}][0]`, returnByValue: false })) as { result?: { objectId?: string } };
    const objectId = ev?.result?.objectId;
    if (!objectId) return undefined;
    try {
      const ax = (await cdp.send('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false })) as { nodes?: { ignored?: boolean; name?: { value?: unknown } }[] };
      const node = ax?.nodes?.[0];
      // An ignored node or one with no name property tells nothing about the name (Sol round 2): unknown.
      if (!node || node.ignored || !node.name) return undefined;
      const v = node.name.value;
      return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : undefined;
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  } catch {
    return undefined;
  } finally {
    await doc.call('unexpose', { key: AX_KEY }).catch(() => {});
    await doc.call('undisclose', {}).catch(() => {});
  }
}

/** Words of a name that say what it is (three letters or more, not the words every form uses). */
const NAME_STOP = new Set(['the', 'and', 'for', 'your', 'you', 'our', 'enter', 'type', 'please', 'here', 'this', 'that', 'with', 'from', 'field', 'input', 'value', 'una', 'los', 'las', 'del', 'por', 'para', 'escriba', 'ingrese']);
const contentWords = (s: string): string[] => (normalizeLabel(s).match(/\p{L}{3,}/gu) ?? []).filter((w) => !NAME_STOP.has(w));
const sameWord = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/**
 * Batch 18, G167 by words (D17; lead's ruling Q2): how much of what a field is called (its accessible name) the button
 * beside it says. 'all': the button names what the field takes ("Apply promo code" for "Promo code"): it labels the
 * field. 'none': it names only an action ("Subscribe", "Request callback" for "Email"): it labels nothing. 'some': a
 * partial overlap ("Check household" for "Household code"): undecided, listed for review.
 */
export function buttonCoverage(fieldName: string, buttonName: string): 'all' | 'none' | 'some' | 'unknown' {
  const own = [...new Set(contentWords(fieldName))];
  const said = contentWords(buttonName);
  if (!own.length) return 'unknown';
  // A button with no word of its own ("Go", "OK", an arrow) names nothing the field takes (lab r1).
  if (!said.length) return 'none';
  const hit = own.filter((w) => said.some((b) => sameWord(w, b))).length;
  if (hit === own.length) return 'all';
  if (hit > 0) return 'some';
  // Precision fix: a button that names nothing the field is called is an action only when every word of it is an
  // action's ("Subscribe", "Request callback"); other words ("Find by postcode" for "ZIP code") may name the field in
  // words the field's name does not use: not decided.
  return said.every((w) => ACTION_WORDS.has(w)) ? 'none' : 'some';
}

/** Words that name a kind many fields share, never one field by themselves (Sol S17). */
const SHARED_FIELD_WORDS = new Set(['number', 'numbers', 'address', 'date', 'code', 'name', 'information', 'details', 'field', 'fields', 'box', 'line', 'type', 'amount', 'time', 'numero', 'fecha', 'codigo']);
/** Words of a button that name only what pressing it does (G167 'none', precision fix). */
const ACTION_WORDS = new Set(['subscribe', 'sign', 'signup', 'join', 'register', 'submit', 'send', 'search', 'find', 'look', 'lookup', 'check', 'status', 'request',
  'callback', 'call', 'back', 'apply', 'continue', 'next', 'save', 'start', 'get', 'notify', 'alert', 'alerts', 'update', 'updates', 'confirm', 'add', 'enter', 'now', 'today',
  'buy', 'pay', 'donate', 'contact', 'ask', 'go', 'yes', 'okay', 'done', 'learn', 'more', 'view', 'show', 'see', 'try', 'free', 'started', 'newsletter', 'news',
  'close', 'print', 'cancel', 'reset', 'clear', 'open', 'download', 'share', 'this', 'about',
  'suscribir', 'suscribirse', 'enviar', 'buscar', 'unirse', 'registrar', 'registrarse', 'continuar', 'siguiente', 'guardar', 'solicitar']);
/** A sentence of the form's own text that says fields are required ("Name and email are required."). */
const REQUIRED_SENTENCE = /[^.!?]*\b((is|are) (required|mandatory|obligatorios?|obligatorias?|requeridos?)|required fields?|must be (filled|completed|provided|entered|answered))\b[^.!?]*/gi;

/**
 * Batch 18 (L-LB-10, L-LB-07; lead's ruling Q8): the page says, before anything is sent, that this field is required:
 * a sentence of the form's text (or the text before it) that says fields are required and names this one; or the
 * page marks the optional fields instead ("(optional)" on another field of the form), which tells the others apart.
 */
export function requiredSaid(f: Pick<ScannedField, 'label' | 'legend' | 'placeholder' | 'name'>, form: Pick<ScannedForm, 'text' | 'context'>, others: readonly Pick<ScannedField, 'label' | 'legend' | 'nearby'>[] = []): boolean {
  if (others.some((o) => /\b(optional|opcional|facultatif)\b/i.test(`${o.label} ${o.nearby} ${o.legend}`))) return true;
  // Fix round (Sol S17): the sentence must name the field by a word of its own; a word many fields share ("number",
  // "address", "date") does not: "Account number is required" says nothing of "Phone number". A field named only by
  // such words is matched by all of them.
  // A shared word names it only when nothing else qualifies it there ("Name and email are required" names "Full name";
  // "Email address is required" does not name "Mailing address").
  const all = contentWords(f.label || f.placeholder || f.name);
  if (!all.length) return false;
  const own = all.filter((w) => !SHARED_FIELD_WORDS.has(w));
  const shared = all.filter((w) => SHARED_FIELD_WORDS.has(w));
  for (const t of [form.text, form.context]) {
    for (const m of (t || '').matchAll(REQUIRED_SENTENCE)) {
      const said = contentWords(m[0]);
      if (own.some((w) => said.some((x) => sameWord(w, x)))) return true;
      const tokens = normalizeLabel(m[0]).match(/\p{L}+/gu) ?? [];
      for (const w of shared) {
        for (let i = 0; i < tokens.length; i++) {
          if (!sameWord(w, tokens[i]!)) continue;
          const prev = tokens[i - 1];
          if (!prev || prev.length < 3 || NAME_STOP.has(prev) || all.includes(prev) || SHARED_FIELD_WORDS.has(prev) || /^(and|or|are|is|the|all|y|o)$/.test(prev)) return true;
        }
      }
    }
  }
  return false;
}

/** What kind of value a field takes, for telling split parts of one value from different questions (ruling Q6). */
const purposeSig = (f: ScannedField): string => {
  const token = parseAutocomplete(f.autocomplete).token ?? '';
  const family = token.replace(/-(day|month|year|national|area-code|local|local-prefix|local-suffix|country-code|extension)$/, '').replace(/^(given|family|additional)-name$/, 'name');
  const type = f.type === 'number' || f.inputMode === 'numeric' ? 'numeric' : f.type;
  return `${type}|${family}`;
};

export function labelFindings(page: Pick<ScannedPage, 'forms' | 'fields'>): { findings: ProbeFinding[]; refs: number[]; checked: number } {
  const out: ProbeFinding[] = [];
  const refs: number[] = [];
  let checked = 0;
  for (const form of page.forms) {
    const facts = formFacts(form, page.fields);
    // Only the field a visible Search button labels (G167) is left out, never its whole form: a search landmark or a
    // field named q is no label (Grok round 2).
    const shown = facts.own.filter((f) => f.shown && f.seen !== false && !f.disabled && f.type !== 'hidden' && !f.search);
    const groups = new Set<string>();
    // Runs of fields one text introduces (ruling Q6): members with no visible text of their own, by the run's key.
    const runs = new Map<number, ScannedField[]>();
    for (const f of shown) if (f.run && !f.visibleLabel && !f.selfLabelled) runs.set(f.run.key, [...(runs.get(f.run.key) ?? []), f]);
    for (const f of shown) {
      checked++;
      // Radio buttons whose options answer a question the page never shows ("Yes" and "No" alone): one per group.
      if (f.type === 'radio' && f.group && f.groupText === '' && !groups.has(f.group) && unaskedOptions(f.groupOptions ?? [])) {
        groups.add(f.group);
        refs.push(f.ref);
        out.push({
          criterion: '3.3.2', status: 'failed', target: fieldTarget(f),
          detail: `the radio buttons ${(f.groupOptions ?? []).slice(0, 4).map((o) => quote(o, 30)).join(', ')} answer a question that is not shown: nothing visible before them or around them says what they are for; give the group a visible question, such as a fieldset legend`,
        });
        continue;
      }
      if (f.visibleLabel || f.selfLabelled) continue;
      // Batch 18 (ruling Q6): one text over a run of fields with no text of their own. Parts of one value ("Phone" over
      // three parts, a date in three lists) are undecided, never failed; a heading over different questions labels none
      // of them (the first included); plain text over different questions labels the first only, as before.
      const run = f.run ? runs.get(f.run.key) : undefined;
      if (f.run && run && run.length >= 2) {
        const one = new Set(run.map(purposeSig)).size === 1;
        if (one) {
          refs.push(f.ref);
          out.push({
            criterion: '3.3.2', status: 'not_testable', target: fieldTarget(f),
            detail: `${run.length} fields of one kind follow ${quote(f.run.text, 60)} with no text of their own; whether each part says what goes in it is not known`,
          });
          continue;
        }
        if (f.run.heading && /\p{L}{2,}/u.test(f.after ?? '')) {
          // Precision fix: text right after the field may be its label (a label on the right): not decided.
          refs.push(f.ref);
          out.push({ criterion: '3.3.2', status: 'not_testable', target: fieldTarget(f), detail: `the heading ${quote(f.run.text, 60)} is over ${run.length} fields that ask different things; the text after this one, ${quote(f.after ?? '', 40)}, may say what it is for: not decided` });
          continue;
        }
        if (f.run.heading) {
          refs.push(f.ref);
          out.push({
            criterion: '3.3.2', status: 'failed', target: fieldTarget(f),
            detail: `the heading ${quote(f.run.text, 60)} is over ${run.length} fields that ask different things, and nothing visible says which field is which${f.placeholder ? ` (only a placeholder: ${quote(f.placeholder, 40)})` : ''}; give each field a visible label`,
          });
          continue;
        }
      }
      if (f.nearby) continue;
      // Its own button (G167), by its words (batch 18, lead's ruling Q2): a button that names what the field takes
      // labels it; one that names only an action labels nothing; a partial overlap is a review case, never scored.
      if (f.buttonLabelled) {
        // A scan that did not read the button's words (before batch 18) leaves it a review case.
        const cover = f.buttonName === undefined ? 'some' : buttonCoverage(f.label, f.buttonName);
        if (cover === 'all') continue;
        if (cover === 'none') {
          refs.push(f.ref);
          out.push({
            criterion: '3.3.2', status: 'failed', target: fieldTarget(f),
            detail: `the field has no visible label; the button next to it, ${quote(f.buttonName ?? '', 60)}, names an action, not what to enter${f.label ? ` (the field is called ${quote(f.label, 60)} only for screen readers)` : ''}; give the field a visible label`,
          });
          continue;
        }
        checked--;
        refs.push(f.ref);
        out.push({
          criterion: '3.3.2', status: 'no_failures_found', advice: true, target: fieldTarget(f),
          detail: `the field has no visible label; the button next to it may say what it is for: check that it does, or give the field a visible label`,
        });
        continue;
      }
      // A check box or radio button in a group with a visible legend and its own label text counts.
      if ((f.type === 'checkbox' || f.type === 'radio') && f.label && f.legend) continue;
      // Batch 19 (precision lane, real-site dev split): the one field of a site search in a search landmark whose only
      // label is its placeholder ("Enter words to search for"). The landmark names its purpose whatever the field
      // shows, the placeholder is shown until people type, and auditors differ on whether that labels a search box: for a
      // person to check, never failed. Narrowed after the gold run (the lead's ruling): a search with a second field, or
      // with nothing lasting that names it (no landmark: a placeholder "Search" sent with "Go"), fails as before, and a
      // field beside a button is judged by the button's words first (batch 18, ruling Q2).
      if (f.placeholder && form.search && form.searchLandmark && TEXT_TYPES.has(f.type)) {
        refs.push(f.ref);
        out.push({
          criterion: '3.3.2', status: 'flagged', target: fieldTarget(f),
          detail: `the site search field's only label is its placeholder ${quote(f.placeholder, 60)}, which disappears as soon as people start typing; whether that is enough for a search box is for a person to check (a visible label, or a Search button beside it, settles it)`,
        });
        continue;
      }
      refs.push(f.ref);
      out.push({
        criterion: '3.3.2', status: 'failed', target: fieldTarget(f),
        detail: f.placeholder
          ? `the field's only label is its placeholder ${quote(f.placeholder, 60)}, which disappears as soon as people start typing; give it a visible label`
          : `the field has no visible label or instructions${f.label ? ` (only a name for screen readers: ${quote(f.label, 60)})` : ''}; give it a visible label`,
      });
    }
    const typed = shown.filter((f) => TEXTISH.has(f.type) || f.type === 'radio' || f.type === 'checkbox');
    if (facts.login || typed.length < 2 || form.allRequired || form.kind === 'loose') continue;
    groups.clear();
    for (const f of typed) {
      if (!f.required || f.requiredMark || f.filled || requiredSaid(f, form, typed.filter((o) => o !== f))) continue;
      if (f.type === 'radio' && f.group) {
        if (groups.has(f.group)) continue;
        groups.add(f.group);
        if (/\*|\b(required|obligatori[oa])\b/i.test(f.legend)) continue;
      }
      refs.push(f.ref);
      // Precision fix (lead's ruling 2026-11-13): words about filling the form in that no rule here reads may say it.
      const talk = requirementTalk(f, form, facts.own);
      out.push(talk
        ? { criterion: '3.3.2', status: 'not_testable', target: fieldTarget(f), detail: `the field must be filled in and nothing here reads as saying so, but the page says ${quote(talk, 80)}, which may: whether people are told it is required is not decided` }
        : {
          criterion: '3.3.2', status: 'failed', target: fieldTarget(f),
          // Scoring v8: lighter than a missing label (the field is labelled; only "required" is not shown).
          minor: true,
          detail: 'the field must be filled in, but nothing visible says so (no asterisk or "required" next to it, and no note that all fields are required)',
        });
    }
  }
  return { findings: out, refs, checked };
}

/** Where an earlier answer is on the page at a later step (`whereValues` in the page). */
export type AnswerPlace = 'shown' | 'disclosure' | 'maybe' | 'back' | 'none' | 'unknown';

/** Content words of a label (three letters or more), for matching a step's own words. */
const contentWordsOf = (s: string): string[] => (normalizeLabel(s).match(/\p{L}{3,}/gu) ?? []).filter((w) => !['the', 'and', 'for', 'your', 'enter', 'again'].includes(w));
/** Purposes that are a person's own whatever they are used for (batch 18, D6): one person has one email address. */
const PERSON_FAMILY = (token: string | undefined): string | undefined => {
  if (!token) return undefined;
  if (token === 'email' || token === 'username') return 'email';
  if (token.startsWith('tel')) return 'tel';
  if (token.startsWith('bday')) return 'bday';
  if (/^(name|given-name|family-name|additional-name|nickname|honorific-prefix|honorific-suffix)$/.test(token)) return 'name';
  return undefined;
};
/** Words that say a field or a step is about someone other than the person filling in the form. */
const OTHER_PARTY = /\b(emergencia|referencias?|arrendador|propietari[oa]|clientes?|testigos?|medic[oa]|supervisora?|second|co-?applicant|another|other|additional|alternate|alternative|secondary|emergency|parents?|guardians?|spouse|partner|child|children|students?|employers?|supervisor|manager|references?|referees?|landlord|tenant|owner|contractor|agent|representative|recipient|beneficiar(y|ies)|witness|friend|relative|physician|doctor|attorney|lawyer|business|company|organi[sz]ation|teacher|coach|caller|customer|applicant 2|person \d)\b/i;
/**
 * Fix round (Sol S1): words that say WHICH of a person's details a field asks for, beyond its kind: "work" and
 * "home" email, "daytime" and "evening" phone, "current" and "new" address, "legal" and "preferred" name. Two fields
 * whose labels (what they are FOR aside: "Email for the decision letter") carry different such words ask for
 * different information, or may: never proof of the same. Every word that is not the detail's kind or a neutral word
 * counts, so a qualifier no list foresaw still separates them.
 */
const QUALIFIER_NEUTRAL = new Set(['your', 'our', 'the', 'and', 'contact', 'applicant', 'applicants', 'address', 'addresses', 'email', 'mail', 'emails',
  'phone', 'telephone', 'number', 'numbers', 'name', 'names', 'full', 'first', 'last', 'given', 'family', 'middle', 'surname', 'date', 'birth', 'birthday',
  'dob', 'username', 'user', 'please', 'enter', 'type', 'provide', 'again', 'confirm', 'required', 'optional', 'correo', 'electronico', 'telefono', 'nombre',
  'apellido', 'direccion', 'fecha', 'nacimiento', 'numero', 'street', 'city', 'state', 'zip', 'code', 'postal', 'postcode', 'tel']);
const FOR_TAIL_WORDS = /\s+(for|where|so|to|we|that|which|at which|para|donde)\b.*$/;
const qualifiersOf = (f: Pick<ScannedField, 'label' | 'placeholder'>): string[] =>
  [...new Set(contentWordsOf(normalizeLabel(f.label || f.placeholder).replace(FOR_TAIL_WORDS, '')).filter((w) => !QUALIFIER_NEUTRAL.has(w)))].sort();
/** The autocomplete hint words a field declares (home, work, mobile, fax, pager; shipping, billing; a section). */
const declaredScope = (f: Pick<ScannedField, 'autocomplete'>): string => (f.autocomplete ?? '').toLowerCase().split(/\s+/)
  .filter((w) => /^(home|work|mobile|fax|pager|shipping|billing)$/.test(w) || w.startsWith('section-')).sort().join(' ');
/** A later field that says it may differ from an earlier answer ("if different", "if not the same as above"). */
const MAY_DIFFER = /\b(if (it is |it'?s |this is )?different|if not the same|if other than|other than (the|your|above)|si es diferente|si es distint[oa])\b/i;
/**
 * Fix round (Sol S1): the step or the field speaks of someone, not the person filling in the form, in words the
 * other-party list does not hold: a question about a person ("Who should we contact?"), "their", "his or her", or a
 * role ("authorized pick-up", "next of kin", "household member", "co-signer", "nominee", "interpreter").
 */
const SOMEONE = /\b(who|whom|whose|their|his|her|person|someone|somebody|nominee|nominat\w*|pick-?\s?up|kin|household|co-?signers?|cosigners?|sponsor|mentor|interpreter|translator|caregiver|carer|advocate|colleague|co-?worker|neighbou?r|roommate|delegate|proxy|authori[sz]ed|referr\w*|quien|persona)\b/i;
/** Words of a reuse control that say only that it reuses ("Use my saved details", "Same as above"). */
const REUSE_FILLER = new Set(['use', 'same', 'copy', 'from', 'fill', 'with', 'saved', 'previous', 'above', 'earlier', 'before', 'information', 'details',
  'info', 'answers', 'answer', 'responses', 'entries', 'profile', 'account', 'data', 'contact', 'step', 'applicant', 'one', 'first', 'what', 'entered',
  'gave', 'you', 'mine', 'mismo', 'misma', 'igual', 'que', 'usar', 'anterior', 'datos', 'informacion']);
/** Whether a reuse control's words cover the earlier answer `then` (and the field `now` asking for it again). */
function reuseCovers(label: string, then: ScannedField, now: ScannedField): boolean {
  const own = contentWordsOf(label).filter((w) => !REUSE_FILLER.has(w));
  if (!own.length) return true;
  const field = new Set([...contentWordsOf(`${then.label} ${then.legend} ${then.name}`), ...contentWordsOf(`${now.label} ${now.legend}`)]);
  return own.some((w) => [...field].some((x) => x === w || (w.length >= 4 && x.length >= 4 && (x.startsWith(w) || w.startsWith(x)))));
}
/** A typed signature or an attestation: re-entering a name to sign is the act itself (essential). */
const SIGNATURE = /\b(sign|signature|signed|initials|attest|certify|e-?sign)\b/i;
/** A step's own words that ask for something again ("For this request, enter your contact email again."). */
const STEP_AGAIN = /\b(again|re-?enter|retype|repeat|once more|de nuevo|otra vez)\b/i;

/**
 * 3.3.7 (pure): fields of a later step that ask again for what an earlier step already took. Asked again: the
 * same purpose, name or label; or a label that says so ("Email again", "Confirm email") over an earlier field of
 * that name or purpose. Not asked again: a field that comes filled in, a "same as" box that offers the earlier
 * answers, a password (security), a choice. And the earlier answer anywhere on the same page counts as available
 * to select (Understanding 3.3.7: "it could be elsewhere on a page, including within a show/hide component"):
 * `where` says where each earlier field's answer is now. The failure needs it to be nowhere on the page ('none')
 * AND proof that it is the same information: the later field's own label says it is asked again ("Confirm
 * email", "Email again"). A matching label, name, guessed or declared purpose is a candidate only (undecided:
 * a heading above the step may name another person, which no field carries); no finding at all when
 * the page itself says it is other information (different declared scopes, or groups with different names and
 * nothing declared the same: "Second applicant").
 * Still shown, or inside something a control on the page shows ('shown', 'disclosure'): no finding. Still in the
 * page but hidden, a control that may bring it back, a value too short to look for, or a page the test did not
 * look at: undecided.
 */
export function redundantFindings(
  earlier: readonly { field: ScannedField; value: string }[],
  later: readonly { field: ScannedField; value: string }[],
  sameAs: string,
  step: number,
  where?: ReadonlyMap<number, AnswerPlace>,
  stepText = '',
): ProbeFinding[] {
  const out: ProbeFinding[] = [];
  const key = (f: ScannedField) => {
    const token = parseAutocomplete(f.autocomplete).token;
    const m = matchInputPurpose({ label: f.label, placeholder: f.placeholder, name: f.name, id: f.id, type: f.type });
    // Batch 18: an email or phone field is one by its type, whatever its words say ("Email for the decision letter").
    const typed = f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : undefined;
    return {
      token: token ?? (m.kind === 'purpose' ? m.purpose : typed),
      name: f.name.toLowerCase().replace(/(step|page)?[\d_\-[\]]+/g, ''),
      label: normalizeLabel(f.label || f.placeholder),
    };
  };
  /** The purpose a field declares, in full ("shipping postal-code", "section-two email"); '' for none, on or off. */
  const declared = (f: ScannedField): string => (parseAutocomplete(f.autocomplete).token ? (f.autocomplete ?? '').trim().toLowerCase().split(/\s+/).join(' ') : '');
  const CONFIRM = /\b(confirm|re-?enter|repeat|verify|again|retype|confirmar|repetir|de nuevo|otra vez)\b/;
  const CONFIRM_ALL = new RegExp(CONFIRM.source, 'g');
  for (const l of later) {
    const f = l.field;
    if (f.type === 'password' || CHOICE_TYPES.has(f.type)) continue;
    const confirm = CONFIRM.test(normalizeLabel(`${f.label} ${f.placeholder}`));
    const k = key(f);
    // "Contact email again" asks for "Contact email": compared without the words that say it is a repeat.
    const bare = confirm ? normalizeLabel(normalizeLabel(f.label || f.placeholder).replace(CONFIRM_ALL, ' ')) : '';
    const bareName = confirm ? k.name.replace(/(again|repeat|confirm|verify|reenter|retype)/g, '') : '';
    const hit = earlier.find((e) => {
      const ek = key(e.field);
      if (e.value === '') return false;
      if (confirm) {
        // "Phone number again" over an earlier "Phone": the words left, or the purpose they name, are the earlier field's.
        const bareToken = (() => { const m = matchInputPurpose({ label: bare, type: f.type }); return m.kind === 'purpose' ? m.purpose : (f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : undefined); })();
        return (bare.length > 2 && bare === ek.label) || (bareName.length > 2 && bareName === ek.name) || (!!bareToken && !!ek.token && acceptedTokens(bareToken as InputPurpose).includes(ek.token as InputPurpose));
      }
      return (k.token && k.token === ek.token) || (k.name.length > 2 && k.name === ek.name) || (k.label.length > 2 && k.label === ek.label);
    });
    if (!hit) continue;
    if (l.value && l.value === hit.value) continue;
    // A control that offers earlier answers ("Same as above", "Use my saved details") makes them available, when it
    // says nothing else or names this answer; one about something else ("Use my saved print settings", "Same as mailing
    // address" for an email) does not (fix round, Sol S12).
    if (sameAs && reuseCovers(sameAs, hit.field, f)) continue;
    // "Confirm email" beside an e-mail field of its own step ("Email", "Co-applicant email") confirms that one,
    // not an earlier step's: a field of the same kind, or one whose label holds the words it confirms.
    if (confirm && later.some((o) => {
      if (o === l || CONFIRM.test(normalizeLabel(`${o.field.label} ${o.field.placeholder}`))) return false;
      const other = normalizeLabel(o.field.label || o.field.placeholder);
      const words = bare.split(' ').filter(Boolean);
      const holds = words.length > 0 && words.every((w) => other.split(' ').includes(w));
      const sameKind = o.field.type === f.type && f.type !== 'text' && f.type !== '';
      const k2 = key(o.field);
      return holds || sameKind || (!!k.token && k.token === k2.token);
    })) continue;
    // That it is the same information needs proof: the field's own label says it is asked again, or both
    // fields declare the same purpose in full (the same autocomplete value, scope included) under the same
    // label, in no group with another name. A matching label, name or guessed purpose only makes it a
    // candidate: "First name" in a later step may be another person's.
    const declaredNow = declared(f);
    const declaredThen = declared(hit.field);
    const sameDeclared = declaredNow !== '' && declaredNow === declaredThen;
    // A group's name may be its step's title or another person's ("Second applicant"): no rule tells them apart.
    const sameGroup = normalizeLabel(f.legend) === normalizeLabel(hit.field.legend);
    // Only the field's own words prove it ("Email again", "Confirm email"): the same label and the same declared
    // purpose do not, because what names another person may be a heading above the step, which no field carries.
    // Batch 18 (D6): the same person's own detail (email, phone, name, birthday) asked again, with nothing in the field,
    // its group or its step that names another party, and no signature: the same information whatever it is used
    // for. The step's own words asking for it again prove it too. Either is strong proof (lead's ruling Q1).
    const fam = PERSON_FAMILY(k.token);
    const ownWords = `${f.label} ${f.legend} ${f.placeholder}`;
    // Fix round (Sol S1): which of the person's details each field asks for. Different declared scopes (work and home),
    // different qualifiers in the labels, or a later field that says it may differ: other information, never proof.
    const scopeNow = declaredScope(f);
    const scopeThen = declaredScope(hit.field);
    const otherScope = (scopeNow !== '' || scopeThen !== '') && scopeNow !== scopeThen;
    const otherWords = qualifiersOf(f).join(' ') !== qualifiersOf(hit.field).join(' ');
    const mayDiffer = MAY_DIFFER.test(`${ownWords} ${f.hint} ${f.nearby} ${f.after ?? ''}`);
    const which = otherScope || otherWords || mayDiffer;
    const personSame = !!fam && !which && fam === PERSON_FAMILY(key(hit.field).token) && !OTHER_PARTY.test(`${ownWords} ${stepText}`)
      && !SOMEONE.test(`${ownWords} ${stepText}`) && !SIGNATURE.test(`${ownWords} ${stepText}`)
      && later.filter((o) => PERSON_FAMILY(key(o.field).token) === fam).length === 1;
    const stepAgain = !confirm && !which && STEP_AGAIN.test(stepText) && !SIGNATURE.test(`${ownWords} ${stepText}`)
      && contentWordsOf(hit.field.label || hit.field.name).some((w) => normalizeLabel(stepText).includes(w));
    const proven = confirm || personSame || stepAgain;
    // Declared for different scopes, or saying it may differ: the page says it is (or may be) other information.
    if (!confirm && (otherScope || mayDiffer)) continue;
    if (!proven) {
      // Declared for different scopes (shipping and billing, two sections): the page says it is other information.
      if (declaredNow && declaredThen && !sameDeclared) continue;
      // In groups with different names and nothing declared the same: other information (a second applicant).
      if (!sameGroup && !sameDeclared) continue;
    }
    const at = where?.get(hit.field.ref);
    // Still on the page, to see or to open: it can be selected and copied (available to select).
    if (at === 'shown' || at === 'disclosure') continue;
    const asked = `step ${step} asks ${proven ? 'again ' : ''}for ${quote(hit.field.label || hit.field.name, 60)}, ${proven ? 'already entered' : 'which was also asked for'} in an earlier step, without filling it in or offering it to select`;
    if ((at === 'none' || at === 'back') && proven) {
      out.push({
        criterion: '3.3.7', status: 'failed', target: fieldTarget(f),
        detail: `${asked}: the earlier answer is nowhere on the page at this step${at === 'back' ? ' (only going back to the earlier step shows it again, which takes this step away)' : ''}`,
      });
    } else {
      const why = !proven ? 'whether it is the same information (and not, say, another person\'s) could not be told from its label'
        : at === 'maybe' ? 'the earlier answer is not shown at this step, but it is still in the page or a control on the page may bring it back, so whether it is available to select could not be told'
        : at === 'unknown' ? 'the earlier answer is too short to look for on the page, so whether it is available to select could not be told' : 'where the earlier answer is at this step was not looked at, so whether it is available to select could not be told';
      out.push({ criterion: '3.3.7', status: 'not_testable', target: fieldTarget(f), detail: `${asked}; ${why}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The probes.

type Gone = { gone: true };
const isGone = (x: unknown): x is Gone => !!x && typeof x === 'object' && (x as Gone).gone === true;
type Call = <T>(op: string, arg?: unknown) => Promise<T | Gone>;

/** Frames that hold a known CAPTCHA widget, not a form of the site. */
const WIDGET_FRAME = /recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs|funcaptcha|friendlycaptcha/i;

/** One document a form test runs in: the page itself (frame 0) or one of its embedded frames. */
interface FormDoc {
  frame: number;
  /** '' for the page itself, else ' (in the embedded frame <address>)', appended to targets. */
  where: string;
  /** Path of the frame's address ('' for the page). */
  path: string;
  call: Call;
  /** Installs the agent; false when the document cannot be tested. */
  install(): Promise<boolean>;
}

/** The page and up to FORMS_MAX_FRAMES of its frames (any origin; not CAPTCHA widgets, not blank). */
function formDocs(ctx: ProbeContext): FormDoc[] {
  const doc = (frame: number, where: string, path: string, evaluate: <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R>): FormDoc => ({
    frame, where, path,
    call: async <T>(op: string, arg?: unknown) => {
      try {
        return (await evaluate(callFormsAgent, { op, arg })) as T | Gone;
      } catch {
        return { gone: true } as Gone;
      }
    },
    install: async () => {
      try {
        return (await evaluate(installFormsAgent, FORMS_CAPS)) === true;
      } catch {
        return false;
      }
    },
  });
  const docs = [doc(0, '', '', (fn, arg) => ctx.page.evaluate(fn, arg))];
  let frames: FrameLike[] = [];
  try {
    frames = ctx.page.frames?.() ?? [];
  } catch {
    frames = [];
  }
  for (const f of frames) {
    if (docs.length > FORMS_MAX_FRAMES) break;
    let url = '';
    try {
      if (f.parentFrame() === null) continue;
      url = f.url();
    } catch {
      continue;
    }
    if (!/^https?:|^about:srcdoc$/i.test(url) || WIDGET_FRAME.test(url)) continue;
    docs.push(doc(docs.length, ` (in the embedded frame ${clip(url, 120)})`, pathOf(url) || url.slice(0, 40), (fn, arg) => f.evaluate(fn, arg)));
  }
  return docs;
}

const where = (doc: FormDoc, list: ProbeFinding[]): ProbeFinding[] =>
  (doc.where ? list.map((f) => ({ ...f, target: clip(`${f.target ?? 'the form'}${doc.where}`, 200) })) : list);

/** Where a field is put for the shared picture helper (`expose` in the forms agent). */
const FIELD_KEY = '__grntedEvidenceField';

/**
 * Report evidence for 3.3.2: each field without a visible label (or required mark) boxed while the page
 * is as loaded, with what is missing in the caption; on the start page, its place on the first screen.
 * Never throws.
 */
async function labelEvidence(ctx: ProbeContext, doc: FormDoc, scanned: ScannedPage, labels: { findings: readonly ProbeFinding[]; refs: readonly number[] }): Promise<void> {
  for (const [i, f] of labels.findings.slice(0, 6).entries()) {
    if (f.status !== 'failed' || f.criterion !== '3.3.2' || ctx.signal.aborted) continue;
    if (!ctx.evidenceHome && !(ctx.evidenceWanted?.('3.3.2') ?? false)) return;
    // The very field the finding is about (another field may share its name).
    const field = scanned.fields.find((x) => x.ref === labels.refs[i] && x.shown);
    if (!field) continue;
    try {
      if ((await doc.call<boolean>('expose', { ref: field.ref, key: FIELD_KEY })) !== true) continue;
      const placeholder = /only label is its placeholder/.test(f.detail);
      const required = /must be filled in/.test(f.detail);
      const target = f.target;
      await shootElements(ctx, {
        criterion: '3.3.2', handles: [{ key: FIELD_KEY, ref: 0 }], target,
        // Kept only while the final run still fails this very field.
        when: (x) => x.target === target,
        caption: placeholder ? 'Only a placeholder labels this field' : required ? 'Nothing visible says this field is required' : 'No visible label',
        alt: (title) => `${pageWords(title)}: the outlined form field ${placeholder ? 'is labeled only by placeholder text, which disappears when people type'
          : required ? 'must be filled in, but nothing visible says so' : 'has no visible label'}.`,
      });
    } catch {
      // Evidence never changes the result.
    } finally {
      await doc.call('unexpose', { key: FIELD_KEY });
    }
  }
}

/** The phone width the labels are read again at (the audit's mobile width). */
export const PHONE_VIEWPORT = { width: 390, height: 844 } as const;

/**
 * 3.3.2 at a phone's width (batch 18, D19): the page is laid out at 390 px, its forms read again, and each field that
 * had visible text of its own on the desktop page and is failed there by the same judgement as the desktop page's
 * (`labelFindings`: a button that names what the field takes labels it, G167; a partial one, a run of parts of one
 * value or anything undecided is no failure: fix round, Sol S2) fails, once. Fields hidden at that width are not
 * judged; the desktop findings (`already`) are not repeated. The viewport is put back. Without a way to change the
 * viewport nothing is said. Refs are stable across reads (Sol S11), so fields are matched by ref.
 */
async function phoneWidthLabels(ctx: ProbeContext, doc: FormDoc, desktop: ScannedPage, already: readonly number[]): Promise<ProbeFinding[]> {
  const page = ctx.page;
  if (!page.setViewportSize || ctx.signal.aborted || ctx.deadline - Date.now() < 3000) return [];
  const back = ctx.viewport ?? { width: 1280, height: 900 };
  const out: ProbeFinding[] = [];
  try {
    await page.setViewportSize({ ...PHONE_VIEWPORT });
    await page.waitForTimeout(300);
    const phone = await doc.call<ScannedPage>('scan', { disclose: true });
    if (isGone(phone)) return [];
    const byRef = new Map(desktop.fields.map((f) => [f.ref, f]));
    const judged = labelFindings(phone);
    const phoneVerdict = new Map<number, ProbeFinding>();
    judged.refs.forEach((ref, i) => { if (!phoneVerdict.has(ref)) phoneVerdict.set(ref, judged.findings[i]!); });
    for (const m of phone.fields) {
      const d = byRef.get(m.ref);
      const v = phoneVerdict.get(m.ref);
      if (!d || !v || v.status !== 'failed' || v.minor || already.includes(d.ref) || d.search || m.search || d.disabled || !d.shown) continue;
      if (d.type === 'checkbox' || d.type === 'radio') continue;
      // Only a field that HAD visible text of its own on the desktop page: the width took it away.
      if (!(d.visibleLabel || !!d.nearby || !!d.selfLabelled)) continue;
      out.push({
        criterion: '3.3.2', status: 'failed', target: fieldTarget(d),
        detail: `at a phone's width (390 px) the field's label is hidden${m.placeholder ? `; only its placeholder ${quote(m.placeholder, 60)} is left, which disappears as people type` : ' and nothing visible says what it is for'}; keep the label visible on small screens`,
      });
    }
  } catch {
    return out;
  } finally {
    await page.setViewportSize({ ...back }).catch(() => {});
    await page.waitForTimeout(150).catch(() => {});
  }
  return out;
}

/** Fields the test could not reach (inside web components, or past the field cap): not testable, with the count. */
function unreached(scanned: ScannedPage, criteria: readonly string[], doc: FormDoc): ProbeFinding[] {
  const parts = [
    ...(scanned.shadowFields ? [`${plural(scanned.shadowFields, 'form field')} inside web components (shadow DOM), which the form test does not reach yet`] : []),
    ...(scanned.cappedFields ? [`${plural(scanned.cappedFields, 'form field')} past the first ${FORMS_CAPS.maxFields}, which the form test does not cover`] : []),
  ];
  if (!parts.length) return [];
  const detail = `the page has ${parts.join(', and ')}`;
  return criteria.map((criterion) => ({ criterion, status: 'not_testable' as const, ...(doc.where ? { target: clip(`the page${doc.where}`, 200) } : {}), detail }));
}

/**
 * Keeps the evidence under the runner's size cap (larger data would be dropped whole): fewer fields
 * per form first, then the last forms. Forms come first in page order, so the AI sample keeps them.
 */
export function fitEvidence<T extends object>(forms: T[], max = PROBE_DATA_MAX_CHARS - 200): T[] {
  const size = (list: T[]) => JSON.stringify({ version: 1, forms: list }).length;
  let out = forms;
  if (size(out) <= max) return out;
  out = out.map((f) => {
    const fields = (f as { fields?: unknown }).fields;
    return Array.isArray(fields) && fields.length > 15 ? { ...f, fields: fields.slice(0, 15) } : f;
  });
  while (out.length && size(out) > max) out = out.slice(0, -1);
  return out;
}

/** An embedded frame the form test could not get into: whatever forms it holds were not tested. */
function frameNotTestable(doc: FormDoc, criteria: readonly string[]): ProbeFinding[] {
  return criteria.map((criterion) => ({
    criterion, status: 'not_testable' as const, target: clip(`the page${doc.where}`, 200), detail: 'the form test could not start inside this embedded frame',
  }));
}

/** Explicit results so every declared criterion has a result on the page. */
function settle(findings: ProbeFinding[], criterion: string, tested: boolean, notTestedDetail: string, testedDetail: string): void {
  if (findings.some((f) => f.criterion === criterion)) return;
  findings.push({ criterion, status: tested ? 'no_failures_found' : 'not_applicable', detail: tested ? testedDetail : notTestedDetail });
}

function purposeOf(f: ScannedField, fx: ReturnType<typeof formFacts>): InputPurpose | undefined {
  const m = matchInputPurpose({ label: f.label, placeholder: f.placeholder, name: f.name, id: f.id, type: f.type, payment: fx.payment, newPassword: fx.signup });
  return m.kind === 'purpose' ? m.purpose : undefined;
}

/** The core probe: what the forms and fields say (1.3.5, 3.3.2, 3.3.4, 3.3.8) and a synthetic paste. */
async function runFormFields(ctx: ProbeContext): Promise<ProbeFinding[]> {
  const findings: ProbeFinding[] = [];
  const evidence: FormEvidence[] = [];
  const left = () => ctx.deadline - Date.now();
  let fieldsSeen = 0;
  let purposeChecked = 0;
  let labelsChecked = 0;
  let tiesChecked = 0;
  let paymentCandidates = 0;
  let authForms = 0;
  let pasted = 0;
  let reachedLimit = false;
  const skipped: string[] = [];
  for (const doc of formDocs(ctx)) {
    if (ctx.signal.aborted || left() < 1500) {
      skipped.push(doc.frame ? `the embedded frame ${doc.path}` : 'the page');
      continue;
    }
    if (!(await doc.install())) {
      if (doc.frame === 0) throw new ProbeNotTestable('the form test could not start on this page');
      findings.push(...frameNotTestable(doc, FORM_FIELDS_CRITERIA));
      reachedLimit = true;
      continue;
    }
    // Closed <details> holding fields are opened while it looks (read-only test: judged as shown).
    const scanned = await doc.call<ScannedPage>('scan', { disclose: true });
    if (isGone(scanned)) {
      if (doc.frame === 0) throw new ProbeNotTestable('the page changed before the form test could start');
      findings.push(...frameNotTestable(doc, FORM_FIELDS_CRITERIA));
      reachedLimit = true;
      continue;
    }
    const missed = unreached(scanned, FORM_FIELDS_CRITERIA, doc);
    findings.push(...missed);
    if (missed.length) reachedLimit = true;
    if (!scanned.fields.length) continue;
    fieldsSeen += scanned.fields.length;
    const byRef = new Map(scanned.fields.map((f) => [f.ref, f]));
    const facts = new Map(scanned.forms.map((f) => [f.index, formFacts(f, scanned.fields)]));

    const purpose = purposeFindings(scanned);
    purposeChecked += purpose.matched + purpose.review.size;
    findings.push(...where(doc, purpose.findings));
    const labels = labelFindings(scanned);
    labelsChecked += labels.checked;
    findings.push(...where(doc, labels.findings));
    const tied = unassociatedLabelFindings(scanned);
    tiesChecked += tied.checked;
    // F111 needs the browser's own accessible name to be empty: each candidate is read in the accessibility tree with
    // the field disclosed as the scan judged it. A name that cannot be read (an ignored node, no name property, no CDP,
    // a refused call, a frame's field) leaves the candidate unconfirmed: 1.3.1 is then not testable there, never clean.
    const confirmed: ProbeFinding[] = [];
    const unconfirmed: string[] = [];
    for (const [i, f] of tied.findings.entries()) {
      const name = doc.frame === 0 && !ctx.signal.aborted ? await axName(ctx, doc, tied.refs[i]!) : undefined;
      if (name === '') confirmed.push(f);
      else if (name === undefined) unconfirmed.push(f.target ?? '');
    }
    findings.push(...where(doc, confirmed));
    if (unconfirmed.length) {
      findings.push(...where(doc, [{
        criterion: '1.3.1', status: 'not_testable', target: unconfirmed.slice(0, 5).join(', '),
        detail: doc.frame !== 0
          ? `${plural(unconfirmed.length, 'field')} in this frame ${unconfirmed.length === 1 ? 'shows' : 'show'} label text not tied to ${unconfirmed.length === 1 ? 'it' : 'them'}; whether the browser gives ${unconfirmed.length === 1 ? 'it' : 'them'} a name could not be read here`
          : `the browser's accessible name of ${plural(unconfirmed.length, 'field')} with label text beside ${unconfirmed.length === 1 ? 'it' : 'them'} could not be read, so whether ${unconfirmed.length === 1 ? 'it has' : 'they have'} a name is not known`,
      }]));
    }
    // Batch 18 (V-LB-07): the same fields at a phone's width. A theme that hides labels on narrow screens leaves
    // only placeholders there; a field labelled on the desktop page and not at 390 px fails at 390 px.
    if (doc.frame === 0) findings.push(...await phoneWidthLabels(ctx, doc, scanned, labels.refs));
    // Pictures of fields with no visible label (page itself only), before anything is typed.
    if (doc.frame === 0) await labelEvidence(ctx, doc, scanned, labels);
    const prevention = preventionFindings(scanned);
    paymentCandidates += prevention.candidates;
    findings.push(...where(doc, prevention.findings));

    // 3.3.8: a synthetic paste into log-in password and code fields (never a real password or code), and since batch 18
    // into the other text fields of a log-in form (a user name, an email, a security answer).
    const paste = new Map<number, { blocked: boolean; via: string }>();
    for (const form of scanned.forms) {
      const fx = facts.get(form.index)!;
      const loginText = fx.login ? fx.own.filter((o) => !fx.passwords.includes(o) && !fx.otp.includes(o) && ['text', 'email', 'tel', ''].includes(o.type) && !/captcha/i.test(`${o.name} ${o.id} ${o.label}`)) : [];
      const targets = [...fx.passwords, ...(fx.otp.length && fx.otp.every((o) => o.maxLength === 1) ? fx.otp.slice(0, 1) : fx.otp), ...loginText.slice(0, 2)];
      for (const f of targets.filter((t) => t.shown && !t.disabled).slice(0, 4)) {
        if (left() < 1000) break;
        const r = await doc.call<{ blocked: boolean; via: string }>('paste', { ref: f.ref, text: fx.passwords.includes(f) ? PASTE_TEXT.password : fx.otp.includes(f) ? PASTE_TEXT.code
          : f.type === 'email' || /\be ?mail\b/.test(fieldWords(f)) ? `${TEST_MARK}@example.invalid` : syntheticValue(f, purposeOf(f, fx)) });
        if (!isGone(r)) {
          paste.set(f.ref, r);
          pasted++;
        }
      }
    }
    const auth = authFindings(scanned, paste);
    authForms += auth.auth;
    findings.push(...where(doc, auth.findings));

    for (const form of scanned.forms) {
      if (form.search) continue;
      const fx = facts.get(form.index)!;
      evidence.push({
        key: `${doc.frame}:${form.index}`, sig: formSig(form, byRef), frame: doc.path,
        name: clip(form.name, 120), context: clip(form.context, 300), text: clip(form.text, 800), method: form.method,
        action: pathOf(form.action), login: fx.login, payment: fx.payment, steps: !!form.next,
        fields: fx.own.slice(0, 30).map((f, i) => ({
          ref: i, type: f.type, label: clip(f.label, 120), name: clip(f.name, 60), placeholder: clip(f.placeholder, 80),
          autocomplete: clip(f.autocomplete ?? '', 80), required: f.required, hint: clip([f.hint, f.title].filter(Boolean).join(' '), 160),
          review: purpose.review.has(f.ref),
          visibleLabel: f.visibleLabel, requiredMark: f.requiredMark, ...(f.legend ? { legend: clip(f.legend, 120) } : {}),
          ...(f.nearby ? { nearby: clip(f.nearby, 80) } : {}), ...(f.after ? { after: clip(f.after, 120) } : {}),
        })),
        buttons: form.buttons.slice(0, 8).map((b) => clip(b, 60)),
        checkboxes: fx.own.filter((f) => f.type === 'checkbox').map((f) => clip(f.label, 160)).slice(0, 8),
        captcha: form.captcha.map((c) => clip(c.detail, 120)).slice(0, 4),
        ...((): Partial<FormEvidence> => {
          const instructions = formInstructions(form, fx.own).slice(0, 8).map((x) => clip(x, 200));
          const targets = new Set([formTarget(form), ...fx.own.map((f) => fieldTarget(f))].map((t) => (doc.where ? clip(`${t}${doc.where}`, 200) : t)));
          const listed = findings.filter((f) => f.status === 'not_testable' && f.target && targets.has(f.target)).slice(0, 12)
            .map((f) => ({ criterion: f.criterion, target: clip(f.target!, 160), detail: clip(f.detail ?? '', 300) }));
          return {
            ...(instructions.length ? { instructions } : {}), ...(form.reviewHeld ? { reviewHeld: clip(form.reviewHeld, 120) } : {}),
            ...(scanned.altLogin.length ? { altLogin: scanned.altLogin.slice(0, 4).map((a) => clip(a, 80)) } : {}), ...(listed.length ? { listed } : {}),
          };
        })(),
      });
    }
  }
  if (!fieldsSeen) {
    if (skipped.length) throw new ProbeNotTestable('the form test ran out of time on this page');
    if (reachedLimit) {
      ctx.setData?.({ version: 1, forms: [] } satisfies FormsProbeData);
      return findings;
    }
    for (const criterion of FORM_FIELDS_CRITERIA) findings.push({ criterion, status: 'not_applicable', detail: 'no form fields on this page' });
    ctx.setData?.({ version: 1, forms: [] } satisfies FormsProbeData);
    return findings;
  }
  if (skipped.length) {
    for (const c of FORM_FIELDS_CRITERIA) findings.push({ criterion: c, status: 'not_testable', target: skipped.join(', '), detail: 'the form test ran out of time before it reached these forms' });
  }
  settle(findings, '1.3.5', purposeChecked > 0, 'no fields that ask for personal information (name, email, phone, address…)', `${plural(purposeChecked, 'field')} that ask for personal information checked`);
  settle(findings, '1.3.1', tiesChecked > 0, 'no form fields people fill in here', `${plural(tiesChecked, 'field')} checked for a label tied to it`);
  settle(findings, '3.3.2', labelsChecked > 0, 'only search fields here, which their button labels, or fields whose own button may label them (left to review)', `${plural(labelsChecked, 'field')} checked for a visible label`);
  settle(findings, '3.3.4', paymentCandidates > 0, 'only search and log-in forms here, which make no legal, financial or data commitment',
    'no form that takes card details and pays on one press without a review step');
  settle(findings, '3.3.8', authForms > 0, 'no log-in, password or one-time code fields on this page',
    `log-in fields checked${pasted ? ` (${plural(pasted, 'paste test')})` : ''}`);
  ctx.setData?.({ version: 1, forms: fitEvidence(evidence) } satisfies FormsProbeData);
  return findings;
}

const DESTRUCTIVE = /\b(delete|remove|cancel|unsubscribe|deactivate|close (my |your )?account|erase|borrar|eliminar|cancelar|darse de baja|dar de baja)\b/i;

/** Why the form's error handling is not tested by submitting it, or undefined when it is. */
export function validationSkip(form: ScannedForm, fx: Pick<ReturnType<typeof formFacts>, 'payment'>): string | undefined {
  if (fx.payment) return 'the form takes card details, so it was not submitted';
  if (!form.submitter && form.kind !== 'form') return 'the form has no button the test could use to submit it';
  if (form.submitter && DESTRUCTIVE.test(form.submitter.label)) return `its button ${quote(form.submitter.label, 60)} looks like it deletes or cancels something, so it was not pressed`;
  if (form.submitter && PAY_BUTTON.test(form.submitter.label)) return `its button ${quote(form.submitter.label, 60)} looks like it pays, so it was not pressed`;
  if (form.target && !/^_(self|top|parent|blank)$/i.test(form.target)) return 'the form sends its answers into a frame on the page, where the test cannot hold them';
  return undefined;
}

function toErrorEvidence(e: { ref: number; text: string; source: 'page' | 'browser' }, own: readonly ScannedField[], after: FormErrorEvidence['after']): FormErrorEvidence {
  return { field: own.findIndex((f) => f.ref === e.ref), after, text: clip(e.text, 200), source: e.source };
}

function dedupeErrors(list: readonly FormErrorEvidence[]): FormErrorEvidence[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const k = `${e.field}\u0000${e.after}\u0000${e.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The path of an address, without matrix parameters (`;jsessionid=…`), which can hold a session. */
function pathOf(url: string): string {
  if (!url) return '';
  try {
    return clip(new URL(url).pathname.replace(/;[^/]*/g, ''), 120);
  } catch {
    return '';
  }
}

/** The deep probe: changes, fills and submits each form with the network shut (3.2.2, 3.3.1, 3.3.3, 3.3.7, 4.1.3). */
/** The `not_testable` result of a page with no form to send: nothing to test, so a planned form may answer it. */
const NO_FORM_STATUS = 'status messages are tested through the messages of a form';

/**
 * The forms test: the page's own forms, then the planned ones (src/probes/plan.ts: fields outside any form
 * element with the control that sends them), tested by the same steps on the same page. A planned form's
 * failures are added, and a criterion it was checked clean on is clean where the page had no form of its
 * own to test; nothing measured on a planned form changes a result of the page's own forms.
 */
async function runForms(ctx: ProbeContext): Promise<ProbeFinding[]> {
  let data: FormsInteractionData | undefined;
  const own = await formsPass({ ...ctx, setData: (d) => { data = d as FormsInteractionData; } });
  const planned = plannedFor(ctx.planned, 'forms', ['form']).flatMap((t) => (t.submit ? [{ root: t.selector, submit: t.submit }] : []));
  let extra: { findings: ProbeFinding[]; data?: FormsInteractionData } | null = null;
  if (planned.length && !ctx.signal.aborted && ctx.deadline - Date.now() >= 3000) {
    let pdata: FormsInteractionData | undefined;
    try {
      const findings = await formsPass({ ...ctx, setData: (d) => { pdata = d as FormsInteractionData; } }, planned);
      extra = { findings, ...(pdata ? { data: pdata } : {}) };
    } catch {
      extra = null;
    }
  }
  if (data || extra?.data) ctx.setData?.({ version: 1, forms: fitEvidence([...(data?.forms ?? []), ...(extra?.data?.forms ?? [])]) } satisfies FormsInteractionData);
  if (!extra) return own;
  const tested = extra.findings;
  const failed = tested.filter((f) => f.status === 'failed');
  const clean = FORMS_CRITERIA.filter((c) => tested.some((f) => f.criterion === c && f.status === 'no_failures_found') && !tested.some((f) => f.criterion === c && f.status !== 'no_failures_found'));
  // What the planned form could not settle (a reason of its own) replaces the page's "no form to test" remark.
  const other = tested.filter((f) => (f.status === 'not_applicable' || f.status === 'not_testable') && !clean.includes(f.criterion as (typeof FORMS_CRITERIA)[number]));
  return mergePlanned(own, { failed, clean, other }, (f) => f.status === 'not_testable' && f.detail.startsWith(NO_FORM_STATUS) && !f.target);
}

async function formsPass(ctx: ProbeContext, planned?: { root: string; submit: string }[]): Promise<ProbeFinding[]> {
  const page = ctx.page;
  const wait = (ms: number) => page.waitForTimeout(ms);
  const left = () => ctx.deadline - Date.now();
  const RESERVE = 3000;
  const startUrl = page.url?.() ?? ctx.url;
  const guardSince = (mark: number) => ctx.guard.since(mark).filter((e) => !e.probe || e.probe === FORMS_PROBE_ID);

  const findings: ProbeFinding[] = [];
  const evidence: FormAttemptEvidence[] = [];
  let fieldsSeen = 0;
  let changed = 0;
  let validated = 0;
  let realForms = 0;
  let stepForms = 0;
  let stepsTested = 0;
  let capped = 0;
  const untested: string[] = [];
  let pageGone = false;
  let reachedLimit = false;

  // The planned pass looks at the page itself only (its forms were picked from the page, not its frames).
  for (const doc of planned ? formDocs(ctx).slice(0, 1) : formDocs(ctx)) {
    if (pageGone) break;
    const call = doc.call;
    if (!(await doc.install()) || isGone(await call<boolean>('record'))) {
      if (doc.frame === 0) throw new ProbeNotTestable('the form test could not start on this page');
      findings.push(...frameNotTestable(doc, FORMS_CRITERIA));
      reachedLimit = true;
      continue;
    }
    const scanned = await call<ScannedPage>('scan', planned ? { planned, plannedOnly: true } : undefined);
    if (isGone(scanned)) {
      if (doc.frame === 0) throw new ProbeNotTestable('the page changed before the form test could start');
      findings.push(...frameNotTestable(doc, FORMS_CRITERIA));
      reachedLimit = true;
      continue;
    }
    const missed = unreached(scanned, FORMS_CRITERIA, doc);
    findings.push(...missed);
    if (missed.length) reachedLimit = true;
    if (!scanned.fields.length) continue;
    fieldsSeen += scanned.fields.length;
    if (scanned.formCount > scanned.forms.length) capped += scanned.formCount - scanned.forms.length;
    const byRef = new Map(scanned.fields.map((f) => [f.ref, f]));
    const facts = new Map(scanned.forms.map((f) => [f.index, formFacts(f, scanned.fields)]));
    // Typing into the page itself goes through the keyboard (as people do); into a frame, through the agent.
    const typeInto = async (ref: number, value: string, focused: boolean) => {
      // One batch of CDP key events where the browser has a session (`typeText`: the same key events, one round trip).
      if (doc.frame === 0 && focused && page.keyboard) await typeText(ctx, await ctx.cdp?.(), value);
      else await call('fill', { values: [{ ref, value }] });
    };

    for (const form of scanned.forms) {
      const fx = facts.get(form.index)!;
      const target = formTarget(form) + doc.where;
      const shownFields = fx.own.filter((f) => f.shown && !f.disabled && !f.readOnly);
      const errors: FormErrorEvidence[] = [];
      // Batch 18: evidence for the forms AI checks (data only): marks with no text, and each later step against the earlier.
      const marksEv: NonNullable<FormAttemptEvidence['marks']> = [];
      const stepPairs: StepPairEvidence[] = [];
      let validation: FormAttemptEvidence['validation'] = 'not_tested';
      let steps = 1;
      if (form.kind !== 'loose' && !form.search) realForms++;
      if (pageGone || ctx.signal.aborted || left() < RESERVE) {
        untested.push(target);
        continue;
      }
      let stopped = false;
      const add = (list: ProbeFinding[]) => findings.push(...where(doc, list));
      if (!shownFields.length) {
        // A form that is not shown (a closed dialog, a collapsed panel) cannot be used as people would.
        if (form.kind !== 'loose' && !form.search) {
          add(['3.2.2', '3.3.1', '3.3.3', '4.1.3'].map((c) => ({
            criterion: c, status: 'not_testable' as const, target: formTarget(form), detail: 'the form is not shown on the page as it loads (for example it is in a closed dialog), so it was not filled in',
          })));
        }
        continue;
      }

      // 3.2.2: change each select, radio group and check box, and type into text fields then leave them.
      const seenGroups = new Set<string>();
      const choices: ScannedField[] = [];
      for (const f of shownFields) {
        if (!CHOICE_TYPES.has(f.type)) continue;
        if (f.type === 'radio' && f.group) {
          if (seenGroups.has(f.group)) continue;
          seenGroups.add(f.group);
        }
        choices.push(f);
      }
      // Nothing is typed into a form that takes card details, nor into password, code, card or PIN fields.
      const texts = fx.payment ? [] : shownFields.filter((f) => TEXT_TYPES.has(f.type) && !isSensitiveField(f)).slice(0, FORMS_TYPED_PER_FORM);
      for (const f of [...choices, ...texts]) {
        if (left() < RESERVE || ctx.signal.aborted) break;
        await call('observe', { form: form.index });
        const focused = await call<boolean>('focusField', { ref: f.ref, clear: TEXT_TYPES.has(f.type) });
        if (isGone(focused)) { pageGone = true; break; }
        const mark = ctx.guard.mark();
        let action: string;
        let statusArmed = false;
        if (CHOICE_TYPES.has(f.type)) {
          // Batch 18 (D12): a choice's own answer ("Showing 8 of 42 programs") is a status message too.
          statusArmed = (await call<boolean>('arm', { form: form.index, near: f.ref })) === true;
          const r = await call<{ ok: boolean; to: string }>('change', { ref: f.ref });
          if (isGone(r)) { pageGone = true; break; }
          if (!r.ok) continue;
          action = f.type === 'checkbox' ? 'ticking or clearing this check box' : `choosing ${quote(r.to, 60)}`;
        } else {
          if (focused !== true) continue;
          await typeInto(f.ref, syntheticValue(f, purposeOf(f, fx)), true);
          await call('blurField', { ref: f.ref });
          action = 'typing in this field and leaving it';
          // 3.3.2 (batch 18, V-LB-08): a label shown until people type, then gone, is a placeholder by another name.
          if ((f.visibleLabel || f.nearby) && !f.search) {
            const still = await call<{ seen: boolean; button?: string; run?: true } | null>('labelSeen', { ref: f.ref });
            // Fix round (Sol S2): the same judgement as the scan's. A button beside it that names what it takes labels
            // it (G167); a partial one, or one text over a run of fields, is undecided: no failure either way.
            const gone = !!still && !isGone(still) && still.seen === false && !still.run
              && (still.button === undefined || buttonCoverage(f.label, still.button) === 'none');
            if (gone) {
              add([{ criterion: '3.3.2', status: 'failed', target: fieldTarget(f), detail: `the field's label${f.label ? ` (${quote(f.label, 60)})` : ''} is shown until people type in it, then disappears, as a placeholder does; keep a visible label` }]);
            }
          }
        }
        await wait(FORMS_WAITS.change);
        const obs = await call<ObserveResult>('observe', { form: form.index });
        changed++;
        if (isGone(obs)) {
          // Batch 19: the same advice rules as any other change of context (`judgeOnInput`): advised beforehand is clean,
          // words the rules cannot classify leave it undecided.
          const advice = advisedBy(f, form);
          const unsure = advice ? '' : unclassifiedAdvice(f, form);
          add([advice
            ? { criterion: '3.2.2', status: 'no_failures_found', target: fieldTarget(f), detail: clip(`${action} reloaded or replaced the page, as the page says beforehand (${quote(advice, 100)})`, 500) }
            : unsure
              ? { criterion: '3.2.2', status: 'not_testable', target: fieldTarget(f), detail: clip(`${action} reloaded or replaced the page; the page says ${quote(unsure, 100)} by it, which may advise people of that beforehand: not decided`, 500) }
              : { criterion: '3.2.2', status: 'failed', target: fieldTarget(f), detail: `${action} reloaded or replaced the page, with no warning beforehand (a change of context on input)` }]);
          pageGone = true;
          break;
        }
        let events = guardSince(mark);
        // A frame that tried to load another address is a change of context only inside that frame.
        if (doc.frame === 0) events = events.filter((e) => !(e.kind === 'blocked' && e.reason === 'data' && e.resourceType === 'document'));
        else events = events.map((e) => (e.kind === 'blocked' && e.resourceType === 'document' ? { ...e, kind: 'navigation' as const } : e));
        const verdict = judgeOnInput(f, form, obs, events, startUrl, action.charAt(0).toUpperCase() + action.slice(1));
        if (verdict === 'dialog') {
          add([{ criterion: '3.2.2', status: 'not_testable', target: fieldTarget(f), detail: `the page showed a dialog after ${action}, so the test of this form stopped there` }]);
          stopped = true;
          break;
        }
        if (verdict) add([verdict]);
        if (statusArmed && !verdict) {
          const said = await call<CollectResult>('collect', { outside: OUTSIDE_STATUS });
          if (!isGone(said)) {
            const st = choiceStatus(said, fieldTarget(f), action);
            if (st) add([st]);
          }
        }
      }
      if (pageGone) { untested.push(target); continue; }
      await call('restore', { form: form.index });

      // 3.3.7: follow the steps of a multi-step form that the page reveals without submitting. This
      // comes first, on the untouched form; the error handling is then tested on the step reached.
      let active: ScannedForm = form;
      let activeFields = shownFields;
      if (form.next && form.kind !== 'loose' && (stopped || fx.payment || left() < RESERVE)) {
        stepForms++;
        add([{
          criterion: '3.3.7', status: 'not_testable', target: formTarget(form),
          detail: fx.payment ? 'the form takes card details, so its steps were not followed'
            : stopped ? 'the page showed a dialog, so the steps of this form were not followed' : 'the form test ran out of time before it followed the steps of this form',
        }]);
      } else if (form.next && form.kind !== 'loose') {
        stepForms++;
        const r = await followSteps(ctx, call, form, fx.own, byRef, (f) => purposeOf(f, fx), guardSince, stepPairs);
        steps = r.steps;
        if (r.gone) pageGone = true;
        if (r.tested) stepsTested++;
        add(r.findings);
        if (pageGone) { untested.push(target); continue; }
        const now = await call<{ ref: number }[]>('shownFields', { form: form.index });
        const sub = await call<ScannedForm['submitter']>('submitterNow', { form: form.index });
        if (!isGone(now) && !isGone(sub)) {
          active = { ...form, submitter: sub };
          activeFields = now.map((v) => byRef.get(v.ref)).filter((f): f is ScannedField => !!f && !f.disabled && !f.readOnly).map((f) => ({ ...f, shown: true }));
        }
      }
      const clear = () => call('restore', { form: form.index, refs: activeFields.map((f) => f.ref) });

      // Error handling: submit empty, then with wrong formats (forms with a way to submit only).
      if (!form.search && form.kind !== 'loose') {
        const skip = stopped ? 'the page showed a dialog while the form was being filled in, so the test stopped there' : validationSkip(active, fx);
        if (skip) {
          add(['3.3.1', '3.3.3', '4.1.3'].map((c) => ({ criterion: c, status: 'not_testable' as const, target: formTarget(form), detail: skip })));
        } else if (left() >= RESERVE) {
          const attempt = async (kind: 'empty' | 'format') => {
            await clear();
            await call('observe', { form: form.index });
            const mark = ctx.guard.mark();
            const armed = await call<boolean>('arm', { form: form.index });
            if (isGone(armed) || !armed) return undefined;
            const formatRefs = new Set<number>();
            if (kind === 'format') {
              const values: { ref: number; value: string }[] = [];
              for (const f of activeFields) {
                // Nothing that looks like a credential is ever typed: password and code fields stay empty.
                if (isSensitiveField(f)) continue;
                if (f.type === 'checkbox' || f.type === 'radio') { if (f.required) values.push({ ref: f.ref, value: 'on' }); continue; }
                if (invalidValue(f) !== undefined) { formatRefs.add(f.ref); continue; }
                if (f.type === 'select' || f.type === 'select-multiple') continue;
                values.push({ ref: f.ref, value: syntheticValue(f, purposeOf(f, fx)) });
              }
              await call('fill', { values });
              for (const ref of formatRefs) {
                const focused = await call<boolean>('focusField', { ref, clear: true });
                await typeInto(ref, invalidValue(byRef.get(ref)!)!, focused === true);
                await call('blurField', { ref });
              }
            }
            await call('markShown');
            await call('submit', { form: form.index, button: active.submitter?.ref ?? -1 });
            await wait(FORMS_WAITS.submit);
            const obs = await call<CollectResult>('collect', { outside: OUTSIDE_ERROR });
            if (isGone(obs)) return undefined;
            await dropSelfChanging(call, obs);
            // The guard's log is read once its decisions are all in (review r1 F5).
            await ctx.guard.settled?.(1000, FORMS_PROBE_ID).catch(() => false);
            // What was in the fields when it was sent (batch 18): the earlier answers if the send opened the next step.
            const typed = activeFields.flatMap((f) => {
              if (isSensitiveField(f) || CHOICE_TYPES.has(f.type)) return [];
              if (formatRefs.has(f.ref)) return [{ ref: f.ref, value: invalidValue(f)! }];
              return kind === 'format' ? [{ ref: f.ref, value: syntheticValue(f, purposeOf(f, fx)) }] : [];
            });
            return { judged: judgeAttempt(active, byRef, obs, guardSince(mark), kind, formatRefs), formatRefs, obs, typed };
          };
          /**
           * The filled-in attempt (`judgeValid`): every field the test may fill gets a plausible test value. The page is
           * armed after the fill (review r1 F3a: what typing or choosing shows is not the send's answer), and a
           * message nobody announced is watched a moment longer before it fails (F3c: a late live region or focus).
           */
          const attemptValid = async () => {
            await clear();
            await call('observe', { form: form.index });
            const values: { ref: number; value: string }[] = [];
            const groups = new Set<string>();
            for (const f of activeFields) {
              // Nothing that looks like a credential is ever typed: password and code fields stay empty.
              if (isSensitiveField(f)) continue;
              if (f.type === 'checkbox') { if (f.required) values.push({ ref: f.ref, value: 'on' }); continue; }
              if (f.type === 'radio') { if (f.group && !groups.has(f.group)) { groups.add(f.group); values.push({ ref: f.ref, value: 'on' }); } continue; }
              if (f.type === 'select' || f.type === 'select-multiple') { values.push({ ref: f.ref, value: FIRST_CHOICE }); continue; }
              values.push({ ref: f.ref, value: syntheticValue(f, purposeOf(f, fx)) });
            }
            await call('fill', { values });
            await wait(FORMS_WAITS.change);
            await call('markShown');
            const mark = ctx.guard.mark();
            const armed = await call<boolean>('arm', { form: form.index });
            if (isGone(armed) || !armed) return undefined;
            await call('submit', { form: form.index, button: active.submitter?.ref ?? -1 });
            await wait(FORMS_WAITS.submit);
            const obs = await call<CollectResult>('collect', { outside: OUTSIDE_STATUS });
            if (isGone(obs)) return undefined;
            await dropSelfChanging(call, obs);
            await ctx.guard.settled?.(1000, FORMS_PROBE_ID).catch(() => false);
            const judged = judgeValid(active, obs, guardSince(mark));
            if (!judged.findings.some((f) => f.status === 'failed')) return { ...judged, values };
            const late = await call<boolean>('lateAnnounce', { ms: FORMS_WAITS.steady });
            return { ...judgeValid(active, obs, guardSince(mark), { late: isGone(late) ? true : late === true }), values };
          };
          const mine = findings.length;
          /** A wrong-format send the page took and moved on with (batch 18): the valid attempt has no first step left. */
          let advancedEarly = false;
          /** The 3.3.1 "no field identified" candidates of the empty and wrong-format attempts (`unidentifiedError`). */
          const unidentifiedCandidates: ProbeFinding[] = [];
          const first = await attempt('empty');
          if (first?.judged.unidentified) unidentifiedCandidates.push(first.judged.unidentified);
          // 3.3.2 required only after sending (D8): candidates that stand when the form takes the filled-in values.
          const demandCandidates = first && first.judged.outcome === 'client' ? demandedFindings(active, byRef, first.obs, fx.login) : [];
          validated++;
          if (!first) {
            add(['3.3.1', '3.3.3', '4.1.3'].map((c) => ({
              criterion: c, status: 'not_testable' as const, target: formTarget(form),
              detail: 'the page was replaced when the form was submitted, so its error messages could not be observed',
            })));
            pageGone = true;
          } else if (first.judged.outcome === 'server' || first.judged.outcome === 'silent' || first.judged.outcome === 'stopped') {
            validation = first.judged.outcome === 'server' ? 'server' : first.judged.outcome === 'silent' ? 'silent' : 'not_tested';
            const areas = fx.own.filter((f) => f.errorArea).length;
            const detail = first.judged.outcome === 'server'
              ? `${SERVER_ONLY} (static check: ${areas} of ${plural(fx.own.length, 'field')} ${areas === 1 ? 'has' : 'have'} a place for error text tied to it with aria-describedby or aria-errormessage)`
              : first.judged.reason!;
            // Batch 18 (break-it r1): a form that says nothing about empty fields may still check what is typed ("Wrong
            // date" only once a value is there): after a silent empty send, the wrong-format send is tried too.
            let formatJudged = false;
            const hasFormat = activeFields.some((f) => invalidValue(f) !== undefined && !isSensitiveField(f));
            if (first.judged.outcome === 'silent' && hasFormat && left() >= RESERVE && !ctx.signal.aborted) {
              const second = await attempt('format');
              if (second && second.judged.outcome === 'client') {
                formatJudged = true;
                validation = 'client';
                add(second.judged.findings);
                if (second.judged.unidentified) unidentifiedCandidates.push(second.judged.unidentified);
                errors.push(...second.judged.errors.filter((e) => second.formatRefs.has(e.ref) || e.ref < 0).map((e) => toErrorEvidence(e, fx.own, 'wrong_format')));
                marksEv.push(...marksOf(second.obs, byRef, 'wrong_format'));
                const note = `${plural(second.judged.seen.messages, 'message')} after values in the wrong format checked`;
                for (const c of ['3.3.1', '4.1.3', '3.3.3']) {
                  if (!findings.slice(mine).some((f) => f.criterion === c)) add([{ criterion: c, status: 'no_failures_found', target: formTarget(form), detail: note }]);
                }
              } else if (!second && isGone(await call('observe', { form: form.index }))) pageGone = true;
              // The page took the wrong-format values and moved on (a step button that checks only for something
              // typed): what it opened is the process's next step, judged against what was in the fields.
              if (second && !pageGone) {
                const still = await call<{ ref: number }[]>('shownFields', { form: form.index });
                if (!isGone(still) && still.length === 0) {
                  advancedEarly = true;
                  const r = await nextStepAfterSend(call, form, second.typed, byRef, stepPairs);
                  if (r === 'gone') pageGone = true;
                  else if (r) { stepForms++; stepsTested++; add(r); }
                }
              }
            }
            if (!formatJudged) add(['3.3.1', '3.3.3', '4.1.3'].map((c) => ({ criterion: c, status: 'not_testable' as const, target: formTarget(form), detail })));
          } else {
            validation = 'client';
            add(first.judged.findings);
            errors.push(...first.judged.errors.map((e) => toErrorEvidence(e, fx.own, 'empty')));
            marksEv.push(...marksOf(first.obs, byRef, 'empty'));
            const hasFormat = activeFields.some((f) => invalidValue(f) !== undefined && !isSensitiveField(f));
            // Anything short of observing the messages after wrong formats leaves the check unfinished.
            const unfinished = (detail: string) => add(['3.3.1', '3.3.3', '4.1.3'].map((c) => ({ criterion: c, status: 'not_testable' as const, target: formTarget(form), detail })));
            if (hasFormat && left() < RESERVE) {
              unfinished('the form test ran out of time before it tried values in the wrong format');
            } else if (hasFormat) {
              const second = await attempt('format');
              if (!second) {
                if (isGone(await call('observe', { form: form.index }))) pageGone = true;
                unfinished(pageGone ? 'the page was replaced when the form was submitted with values in the wrong format, so its error messages could not be observed'
                  : 'the form could not be submitted again with values in the wrong format');
              } else if (second.judged.outcome === 'client') {
                add(second.judged.findings);
                if (second.judged.unidentified) unidentifiedCandidates.push(second.judged.unidentified);
                errors.push(...second.judged.errors.filter((e) => second.formatRefs.has(e.ref) || e.ref < 0).map((e) => toErrorEvidence(e, fx.own, 'wrong_format')));
                marksEv.push(...marksOf(second.obs, byRef, 'wrong_format'));
              } else if (second.judged.outcome === 'server') {
                unfinished(`with values in the wrong format, ${SERVER_ONLY}`);
              } else {
                unfinished(`with values in the wrong format, ${second.judged.reason ?? 'the page showed nothing'}`);
              }
            }
            const seen = first.judged.seen;
            const note = `${plural(seen.messages, 'message')} and ${plural(seen.native, 'browser validation message')} checked`;
            for (const c of ['3.3.1', '4.1.3', '3.3.3']) {
              if (!findings.slice(mine).some((f) => f.criterion === c)) add([{ criterion: c, status: 'no_failures_found', target: formTarget(form), detail: note }]);
            }
          }
          // The filled-in attempt, on a form that handled the empty one in the page (or showed nothing for it).
          if (first && !pageGone && !advancedEarly && (first.judged.outcome === 'client' || first.judged.outcome === 'silent') && left() >= RESERVE && !ctx.signal.aborted) {
            const v = await attemptValid();
            if (v === undefined) { if (isGone(await call('observe', { form: form.index }))) pageGone = true; }
            else {
              // 3.3.7 across forms (batch 18, V-RE-02): the form the page took in the browser went away and other fields
              // took its place (a second form, a cover sheet): they are the process's next step.
              let step: ProbeFinding[] | null = null;
              if ((v.outcome === 'client' || v.outcome === 'silent') && left() >= RESERVE && !ctx.signal.aborted) {
                const r = await nextStepAfterSend(call, form, v.values, byRef, stepPairs);
                if (r === 'gone') pageGone = true;
                else if (r) { stepForms++; stepsTested++; step = r; }
              }
              if (v.outcome === 'client') {
                // When the send opened the next step, what it shows is that step's content (its intro, a summary of
                // the answers), not a status message: 4.1.3 is not judged from it (batch 18, precision).
                add(step ? v.findings.map((f) => (f.criterion === '4.1.3' && f.status === 'failed'
                  ? { ...f, status: 'not_testable' as const, detail: 'sending the filled-in form opened its next step; what the page shows then is that step\'s content, so whether a status message was announced is not told' }
                  : f)) : v.findings);
              }
              if (step) add(step);
              // 3.3.1 "no field identified" stands only when the same form takes the filled-in values (review r1 F4):
              // the error was about what was typed, not a sign-in, a closed form, a CAPTCHA or a file it needs.
              if (v.outcome === 'server' || v.outcome === 'client') add(unidentifiedCandidates);
              if (v.outcome === 'server' || v.outcome === 'client' || v.outcome === 'silent') add(demandCandidates);
            }
          }
          await clear();
        } else {
          untested.push(target);
        }
      }


      if (!form.search && form.kind !== 'loose') {
        const targets = new Set([formTarget(form), ...fx.own.map((f) => fieldTarget(f))]);
        const listed = findings.filter((f) => f.status === 'not_testable' && f.target && targets.has(f.target)).slice(0, 12)
          .map((f) => ({ criterion: f.criterion, target: clip(f.target!, 160), detail: clip(f.detail ?? '', 300) }));
        evidence.push({
          key: `${doc.frame}:${form.index}`, sig: formSig(form, byRef), validation, errors: dedupeErrors(errors).slice(0, 20), steps,
          ...(marksEv.length ? { marks: marksEv.slice(0, 12) } : {}), ...(stepPairs.length ? { stepPairs: stepPairs.slice(0, 3) } : {}), ...(listed.length ? { listed } : {}),
        });
      }
    }
  }

  if (!fieldsSeen && reachedLimit) {
    ctx.setData?.({ version: 1, forms: [] } satisfies FormsInteractionData);
    return findings;
  }
  if (!fieldsSeen) {
    for (const criterion of FORMS_CRITERIA) {
      findings.push(criterion === '4.1.3'
        ? { criterion, status: 'not_testable', detail: 'status messages are tested through the messages of a form, and this page has no form fields', nothingToTest: true }
        : { criterion, status: 'not_applicable', detail: 'no form fields on this page' });
    }
    ctx.setData?.({ version: 1, forms: [] } satisfies FormsInteractionData);
    return findings;
  }
  if (untested.length) {
    const reason = pageGone ? 'the page was replaced during the form test' : 'the form test ran out of time on this page';
    for (const c of ['3.2.2', '3.3.1', '3.3.3', '4.1.3']) findings.push({ criterion: c, status: 'not_testable', target: clip(untested.join(', '), 200), detail: reason });
  }
  if (capped) {
    for (const c of FORMS_CRITERIA) findings.push({ criterion: c, status: 'not_testable', detail: `the page has more forms than the test covers; ${plural(capped, 'form')} after the first ${FORMS_CAPS.maxForms} were not tested` });
  }
  settle(findings, '3.2.2', changed > 0, 'no field on this page could be changed', `${plural(changed, 'field')} changed without a change of context`);
  const noSubmit = realForms ? 'no form here could be submitted in the test' : 'only search forms and fields outside forms here, which have no error messages to test';
  for (const c of ['3.3.1', '3.3.3']) settle(findings, c, validated > 0, noSubmit, 'error messages checked');
  if (!findings.some((f) => f.criterion === '4.1.3')) {
    // Status messages are tested through form errors; without a form to submit nothing was tested.
    findings.push(validated > 0
      ? { criterion: '4.1.3', status: 'no_failures_found', detail: 'error messages checked' }
      : { criterion: '4.1.3', status: 'not_testable', detail: `status messages are tested through the messages of a form; ${noSubmit}`, ...(realForms ? {} : { nothingToTest: true as const }) });
  }
  if (stepForms && !stepsTested && !findings.some((f) => f.criterion === '3.3.7')) {
    findings.push({ criterion: '3.3.7', status: 'not_testable', detail: 'the steps of the form could not be followed' });
  }
  settle(findings, '3.3.7', stepsTested > 0, 'no form on this page is split into steps that open on the page', 'later steps checked for repeated questions');
  // 3.3.2 here only covers what typing and sending show (a label that vanishes, a field required only after sending);
  // the form-fields test judges the rest.
  settle(findings, '3.3.2', validated > 0 || changed > 0, 'no field here could be typed into or sent', 'labels kept after typing, and required fields shown before sending');
  ctx.setData?.({ version: 1, forms: fitEvidence(evidence) } satisfies FormsInteractionData);
  return findings;
}

/** Batch 18 (evidence for the forms AI checks): fields marked as wrong after an attempt, with no text of their own. */
function marksOf(obs: CollectResult, byRef: ReadonlyMap<number, ScannedField>, after: 'empty' | 'wrong_format'): NonNullable<FormAttemptEvidence['marks']> {
  return obs.marks.filter((mk) => !obs.messages.some((m) => m.assoc.includes(mk.ref) || m.names.includes(mk.ref) || m.near === mk.ref)).slice(0, 12).map((mk) => ({
    field: byRef.get(mk.ref) ? fieldTarget(byRef.get(mk.ref)!) : 'a field', after,
    how: mk.symbol ? 'a symbol with no words' : mk.icon ? 'an icon' : mk.style ? 'a colour change' : mk.cls ? 'a change of style' : 'aria-invalid only',
  }));
}
/** Batch 18 (evidence for the 3.3.7 check): one later step against the earlier answers, by labels and purposes only. */
function stepPairOf(step: number, earlier: readonly { field: ScannedField }[], later: readonly { field: ScannedField; value: string }[], where: ReadonlyMap<number, AnswerPlace> | undefined, reuse: string, stepText: string): StepPairEvidence {
  return {
    step, stepText: clip(stepText, 400), reuse: clip(reuse, 80),
    earlier: earlier.slice(0, 20).map((e) => ({ label: clip(e.field.label || e.field.placeholder || e.field.name, 100), type: e.field.type, autocomplete: clip(e.field.autocomplete ?? '', 60), legend: clip(e.field.legend, 80), where: where?.get(e.field.ref) ?? 'unknown' })),
    later: later.slice(0, 20).map((l) => ({ label: clip(l.field.label || l.field.placeholder || l.field.name, 100), type: l.field.type, autocomplete: clip(l.field.autocomplete ?? '', 60), legend: clip(l.field.legend, 80), hint: clip(l.field.hint, 120), filled: l.value !== '' })),
  };
}

/** Fills each visible step with test values and presses "Next", up to FORMS_MAX_STEPS steps. */
/** What `freshScan` returns: the page read again, and the fields shown now that were not at `markShown`. */
interface FreshScan { page: ScannedPage; fresh: number[]; values: string[]; stepText: string; markedShown: number }

/**
 * After the filled-in form was sent and the page answered in the browser: when the form's own fields are no longer
 * shown and other fields are (`freshScan`: revealed or created by the send), those are the next step of the same
 * process, and each is judged against what was just entered (`redundantFindings`). A form that stays on screen keeps
 * its answers there (available), so it is no step. Returns the findings, null when no step opened, 'gone'.
 */
async function nextStepAfterSend(call: Call, form: ScannedForm, values: readonly { ref: number; value: string }[], byRef: Map<number, ScannedField>, sink?: StepPairEvidence[]): Promise<ProbeFinding[] | null | 'gone'> {
  const still = await call<{ ref: number }[]>('shownFields', { form: form.index });
  if (isGone(still)) return 'gone';
  if (still.length) return null;
  const fs = await call<FreshScan>('freshScan', {});
  if (isGone(fs)) return 'gone';
  if (!fs.fresh.length) return null;
  for (const f of fs.page.fields) byRef.set(f.ref, f);
  const earlier = values.flatMap((v) => {
    const f = byRef.get(v.ref);
    return f && !CHOICE_TYPES.has(f.type) && v.value !== FIRST_CHOICE ? [{ field: f, value: v.value }] : [];
  });
  const later = fs.fresh.map((ref, i) => ({ field: byRef.get(ref)!, value: fs.values[i] ?? '' })).filter((x) => x.field);
  const sameAs = await call<string>('sameAsOffered', { form: form.index, refs: fs.fresh });
  const places = await call<AnswerPlace[]>('whereValues', { items: earlier.map((e) => ({ ref: e.field.ref, value: e.value })), except: fs.fresh });
  const where = isGone(places) || !Array.isArray(places) ? undefined : new Map(earlier.map((e, i) => [e.field.ref, places[i] ?? 'unknown'] as const));
  sink?.push(stepPairOf(2, earlier, later, where, isGone(sameAs) ? '' : sameAs, fs.stepText));
  const out = redundantFindings(earlier, later, isGone(sameAs) ? '' : sameAs, 2, where, fs.stepText);
  return out.length ? out : [{ criterion: '3.3.7', status: 'no_failures_found', target: formTarget(form), detail: 'sending the form opened its next step, which does not ask again for what was entered' }];
}

async function followSteps(
  ctx: ProbeContext,
  call: Call,
  form: ScannedForm,
  own: readonly ScannedField[],
  byRef: Map<number, ScannedField>,
  purposeFor: (f: ScannedField) => InputPurpose | undefined,
  guardSince: (mark: number) => GuardEvent[],
  sink?: StepPairEvidence[],
): Promise<{ findings: ProbeFinding[]; steps: number; tested: boolean; gone: boolean }> {
  const findings: ProbeFinding[] = [];
  const entered: { field: ScannedField; value: string }[] = [];
  let visible = await call<{ ref: number; value: string; checked: boolean }[]>('shownFields', { form: form.index });
  if (isGone(visible)) return { findings, steps: 1, tested: false, gone: true };
  let step = 1;
  let tested = false;
  const nextRef = form.next!.ref;
  const seenRefs = new Set(visible.map((v) => v.ref));
  while (step <= FORMS_MAX_STEPS && ctx.deadline - Date.now() > 3000) {
    const current = visible.map((v) => byRef.get(v.ref)).filter((f): f is ScannedField => !!f && !f.disabled && !f.readOnly);
    const values = current.flatMap((f) => {
      if (isSensitiveField(f)) return [];
      if (f.type === 'checkbox' || f.type === 'radio') return f.required ? [{ ref: f.ref, value: 'on' }] : [];
      if (f.type === 'select' || f.type === 'select-multiple') return [];
      return [{ ref: f.ref, value: syntheticValue(f, purposeFor(f)) }];
    });
    await call('fill', { values });
    const after = await call<{ ref: number; value: string; checked: boolean }[]>('shownFields', { form: form.index });
    if (isGone(after)) return { findings, steps: step, tested, gone: true };
    for (const v of after) {
      const f = byRef.get(v.ref);
      if (f && !entered.some((e) => e.field.ref === f.ref)) entered.push({ field: f, value: v.value });
    }
    // Fields of a step the test reached that are not the form's own scan-time fields (created or read again).
    for (const v of values) {
      const f = byRef.get(v.ref);
      if (f && !entered.some((e) => e.field.ref === f.ref)) entered.push({ field: f, value: v.value });
    }
    await call('observe', { form: form.index });
    await call('markShown');
    const mark = ctx.guard.mark();
    await call('click', { button: nextRef });
    await ctx.page.waitForTimeout(FORMS_WAITS.step);
    const obs = await call<ObserveResult>('observe', { form: form.index });
    if (isGone(obs)) return { findings, steps: step, tested, gone: true };
    const events = guardSince(mark);
    if (events.some((e) => e.kind === 'dialog')) {
      if (!tested) findings.push({ criterion: '3.3.7', status: 'not_testable', target: formTarget(form), detail: 'the page showed a dialog when the next step was asked for, so the steps were not followed' });
      break;
    }
    const submitted = obs.protoSubmits.includes(form.index) || obs.submits.some((s) => s.form === form.index && !s.prevented);
    const sent = submitted || obs.net.length > 0 || sentData(events, { submitted });
    if (sent) {
      if (!tested) findings.push({ criterion: '3.3.7', status: 'not_testable', target: formTarget(form), detail: 'the next step of this form comes from the live server; it was not opened to avoid sending data' });
      break;
    }
    // Batch 18 (V-RE-03, -08, -09): the page read again: fields revealed anywhere, or created since (a step a script
    // renders on demand, a dialog), are the next step's.
    const fs = await call<FreshScan>('freshScan', {});
    if (isGone(fs)) return { findings, steps: step, tested, gone: true };
    for (const f of fs.page.fields) byRef.set(f.ref, f);
    const fresh = fs.fresh.map((ref, i) => ({ ref, value: fs.values[i] ?? '', checked: false }));
    const now = fresh;
    if (!fresh.length) {
      if (!tested) findings.push({ criterion: '3.3.7', status: 'not_testable', target: formTarget(form), detail: `pressing ${quote(form.next!.label, 40)} with test answers did not open the next step` });
      break;
    }
    step++;
    tested = true;
    const sameAs = await call<string>('sameAsOffered', { form: form.index, refs: fresh.map((v) => v.ref) });
    const later = fresh.map((v) => ({ field: byRef.get(v.ref)!, value: v.value })).filter((x) => x.field);
    const answered = entered.filter((e) => !fresh.some((v) => v.ref === e.field.ref));
    // Where each earlier answer is on the page now: anywhere on the same page counts as available to select.
    const places = await call<AnswerPlace[]>('whereValues', { items: answered.map((e) => ({ ref: e.field.ref, value: e.value })), except: fresh.map((v) => v.ref), next: nextRef });
    const where = isGone(places) || !Array.isArray(places) ? undefined : new Map(answered.map((e, i) => [e.field.ref, places[i] ?? 'unknown'] as const));
    sink?.push(stepPairOf(step, answered, later, where, isGone(sameAs) ? '' : sameAs, fs.stepText));
    findings.push(...redundantFindings(answered, later, isGone(sameAs) ? '' : sameAs, step, where, fs.stepText));
    visible = fresh;
    for (const v of now) seenRefs.add(v.ref);
    // Stop when every field hidden at the start has been shown.
    if (!own.some((f) => !f.shown && !seenRefs.has(f.ref))) break;
  }
  return { findings, steps: step, tested, gone: false };
}

/**
 * Core: reads the forms and fields (1.3.1 labels not tied to their field, 1.3.5, 3.3.2, 3.3.4, 3.3.8) and pastes
 * a test value into log-in password and code fields. Cheap (a DOM read per document), so it shares the page with
 * other core probes; register it after them, since it pastes into fields. An app that mounts its form late is read
 * with it (`waitFor.content`), never as an empty shell.
 */
export const formFieldsProbe: PageProbe = {
  id: FORM_FIELDS_PROBE_ID,
  criteria: [...FORM_FIELDS_CRITERIA],
  waitFor: { content: true },
  kind: 'interaction',
  tier: 'core',
  timeoutMs: 10_000,
  sendsNothing: true,
  run: withoutDownloads(runFormFields),
};

/** Deep (`--full`): fills, changes and submits every form on a page of its own, with the network shut. */
export const formsProbe: PageProbe = {
  id: FORMS_PROBE_ID,
  usesPlan: true,
  criteria: [...FORMS_CRITERIA],
  kind: 'interaction',
  // A page that mounts its content late has no form yet when it loads: wait for it (bounded), as form-fields does
  // (act-watch lane, 2026-11-11: before, such a form was "no form fields" here).
  waitFor: { content: true },
  tier: 'deep',
  timeoutMs: 30_000,
  isolate: true,
  sendsNothing: true,
  run: withoutDownloads(runForms),
};
