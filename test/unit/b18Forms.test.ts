// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, forms lane (docs/atlas/forms.md): the red tests of each new decision path's pure judge. Each test names
// its decision path (D-number) and the atlas variants (V-) and look-alikes (L-) it stands for.
import { describe, expect, it } from 'vitest';
import { advisedBy, authFindings, buttonCoverage, choiceStatus, demandedFindings, formatShownBy, invalidValue, judgeAttempt, judgeOnInput, labelFindings, preventionFindings, purposeFindings, redundantFindings, requiredSaid, restatesOnly } from '../../src/probes/forms.js';
import { confirmOrientation } from '../../src/probes/orientation.js';
import { matchInputPurpose } from '../../src/probes/inputPurpose.js';
import type { CollectedMessage, CollectResult, ObserveResult, ScannedField, ScannedForm } from '../../src/probes/formsPage.js';
import type { GuardEvent } from '../../src/probes/types.js';

export const field = (over: Partial<ScannedField> = {}): ScannedField => ({
  ref: 0, form: 0, tag: 'input', type: 'text', name: '', id: '', label: 'Name', legend: '', placeholder: '', autocomplete: null, required: false,
  pattern: '', title: '', minLength: -1, maxLength: -1, min: '', max: '', inputMode: '', shown: true, disabled: false, readOnly: false, group: '',
  hint: '', errorArea: false, visibleLabel: true, nearby: '', requiredMark: false, checked: false, options: 0, ...over,
});
export const form = (over: Partial<ScannedForm> = {}): ScannedForm => ({
  index: 0, kind: 'form', name: 'Contact', context: '', text: '', method: 'post', action: 'https://e.org/contact', target: '', noValidate: false,
  search: false, fields: [0], fieldCount: 1, submitter: { ref: 0, label: 'Send', kind: 'submit' }, buttons: ['Send'], next: null, hiddenFields: 0,
  captcha: [], allRequired: false, ...over,
});
const observe = (over: Partial<ObserveResult> = {}): ObserveResult => ({
  submits: [], protoSubmits: [], opens: 0, net: [], url: 'https://e.org/', active: { to: 'body', ref: -1, form: -1, label: '' }, ...over,
});
const ev = (e: Partial<GuardEvent>): GuardEvent => ({ kind: 'blocked', at: 0, ...e });

describe('D15 3.2.2 advised beforehand (V-OI-01, L-OI-04)', () => {
  const nav = [ev({ kind: 'navigation', url: 'https://e.org/parks' })];
  const judge = (f: ScannedField, fm: ScannedForm = form(), obs: Partial<ObserveResult> = {}, g: GuardEvent[] = nav) =>
    judgeOnInput(f, fm, observe(obs), g, 'https://e.org/', 'Choosing "Parks"');

  it('a jump menu with nothing said beforehand fails', () => {
    expect(judge(field({ type: 'select', label: 'Department' }))).toMatchObject({ status: 'failed' });
    // Words that are not about what the change does are no advice.
    expect(judge(field({ type: 'select', label: 'Department', nearby: 'Find a department' }))).toMatchObject({ status: 'failed' });
    expect(judge(field({ type: 'select', label: 'Load size' }))).toMatchObject({ status: 'failed' });
    expect(judge(field({ type: 'select', label: 'Department' }), form({ text: 'Submit your question with the form below.' }))).toMatchObject({ status: 'failed' });
  });

  it('the same change, said beforehand in the label, its description, the text after it, its legend or the form\'s instructions, is clean', () => {
    for (const over of [
      { label: 'Department (opens its page)' },
      { hint: 'Choosing a department takes you to its page.' },
      { after: 'The page opens as soon as you choose.' },
      { legend: 'Quick links: the page loads automatically' },
      { title: 'Opens in a new tab' },
    ] as Partial<ScannedField>[]) {
      expect(judge(field({ type: 'select', label: 'Department', ...over })), JSON.stringify(over)).toMatchObject({ status: 'no_failures_found' });
    }
    expect(judge(field({ type: 'select', label: 'Department' }), form({ text: 'Selecting a department opens its page.' }))).toMatchObject({ status: 'no_failures_found' });
    expect(advisedBy(field({ label: 'Month' }), form({ context: 'Choose a month and its agenda loads automatically.' }))).not.toBe('');
  });

  it('focus moved into a dialog the choice opened is undecided (ruling Q7), not failed; advised, it is clean', () => {
    const into = { active: { to: 'other' as const, ref: -1, form: -1, label: 'dialog New address', dialog: true as const } };
    expect(judge(field({ type: 'select', label: 'Address' }), form(), into, [])).toMatchObject({ status: 'not_testable' });
    expect(judge(field({ type: 'select', label: 'Address' }), form(), { active: { to: 'other', ref: -1, form: -1, label: 'Search' } }, [])).toMatchObject({ status: 'failed' });
  });
});

const collect = (over: Partial<CollectResult> = {}): CollectResult => ({
  submits: [], protoSubmits: [], opens: 0, net: [], invalid: [], reported: false, formGone: false, messages: [], marks: [], announcements: [],
  active: { to: 'body', ref: -1, form: -1, label: '' }, activeBefore: { to: 'body', ref: -1, form: -1, label: '' }, focusMoved: false, ...over,
});
const msg = (over: Partial<CollectedMessage>): CollectedMessage => ({ text: '', kind: 'added', near: -1, assoc: [], names: [], live: false, focus: false, ...over });

describe('D17 3.3.2 G167 by words (V-LB-05, L-LB-22; ruling Q2)', () => {
  it('a button that names what the field takes labels it; one that names an action labels nothing; a partial overlap is undecided', () => {
    expect(buttonCoverage('Promo code', 'Apply promo code')).toBe('all');
    expect(buttonCoverage('Tracking number', 'Track number')).toBe('all');
    expect(buttonCoverage('Email', 'Subscribe')).toBe('none');
    expect(buttonCoverage('Your phone number', 'Request callback')).toBe('none');
    expect(buttonCoverage('Household code', 'Check household')).toBe('some');
    expect(buttonCoverage('', 'Go')).toBe('unknown');
    expect(buttonCoverage('Account number', 'Go')).toBe('none');
  });
  it('labelFindings: action-only button fails, a naming button is clean, a partial one stays a review case', () => {
    const page = (buttonName: string, label = 'Email') => ({ forms: [form({ fields: [0] })], fields: [field({ label, visibleLabel: false, buttonLabelled: true, buttonName })] });
    expect(labelFindings(page('Subscribe')).findings).toMatchObject([{ criterion: '3.3.2', status: 'failed', detail: expect.stringContaining('names an action') }]);
    expect(labelFindings(page('Sign up with your email')).findings).toEqual([]);
    expect(labelFindings(page('Check household', 'Household code')).findings).toMatchObject([{ status: 'no_failures_found', advice: true }]);
  });
});

describe('Q6 3.3.2 runs of fields under one text (V-LB-22, ruling Q6)', () => {
  const run = (key: number, heading: boolean, size: number, text: string) => ({ key, heading, size, text });
  it('a heading over fields that ask different things labels none of them, the first included', () => {
    const r = run(1, true, 2, 'Contact');
    const fs = [field({ ref: 0, type: 'email', label: '', visibleLabel: false, nearby: 'Contact', run: r }), field({ ref: 1, type: 'tel', label: '', visibleLabel: false, run: r })];
    const out = labelFindings({ forms: [form({ fields: [0, 1] })], fields: fs }).findings.filter((f) => f.criterion === '3.3.2');
    expect(out.map((f) => f.status)).toEqual(['failed', 'failed']);
  });
  it('parts of one value under one text (a phone in three parts, a date in three lists) are undecided, never failed', () => {
    const r = run(2, false, 3, 'Phone number');
    const fs = [0, 1, 2].map((i) => field({ ref: i, type: 'text', inputMode: 'numeric', label: '', visibleLabel: false, ...(i === 0 ? { nearby: 'Phone number' } : {}), run: r }));
    const out = labelFindings({ forms: [form({ fields: [0, 1, 2] })], fields: fs }).findings;
    expect(out.map((f) => f.status)).toEqual(['not_testable', 'not_testable', 'not_testable']);
    const h = run(3, true, 3, 'Date of birth');
    const ds = [0, 1, 2].map((i) => field({ ref: i, type: 'select', label: '', visibleLabel: false, ...(i === 0 ? { nearby: 'Date of birth' } : {}), run: h }));
    expect(labelFindings({ forms: [form({ fields: [0, 1, 2] })], fields: ds }).findings.every((f) => f.status === 'not_testable')).toBe(true);
  });
  it('plain text over fields that ask different things labels the first only, as before', () => {
    const r = run(4, false, 2, 'Contact');
    const fs = [field({ ref: 0, type: 'email', label: '', visibleLabel: false, nearby: 'Contact', run: r }), field({ ref: 1, type: 'tel', label: '', visibleLabel: false, run: r })];
    expect(labelFindings({ forms: [form({ fields: [0, 1] })], fields: fs }).findings.map((f) => [f.target, f.status])).toEqual([['tel field', 'failed']].map(([, st]) => [expect.any(String), st]));
  });
});

describe('D8 3.3.2 required only after sending (V-LB-11, L-LB-07, L-LB-10; ruling Q8)', () => {
  const fs = [field({ ref: 0, label: 'Full name' }), field({ ref: 1, label: 'Street address' }), field({ ref: 2, label: 'Town' })];
  const byRef = new Map(fs.map((f) => [f.ref, f]));
  const fm = form({ fields: [0, 1, 2] });
  const ask = msg({ text: 'Enter your full name, street address, and town to continue.', names: [0, 1, 2], inForm: true });
  it('RED: fields the empty attempt asks for, with nothing visible saying they are required, fail (minor)', () => {
    const out = demandedFindings(fm, byRef, collect({ messages: [ask] }), false);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ criterion: '3.3.2', status: 'failed', minor: true, detail: expect.stringContaining('Enter your full name') });
    // Marked as missing by style alone counts as asked for too.
    expect(demandedFindings(fm, byRef, collect({ marks: [{ ref: 1, aria: false, style: true, cls: false, icon: false }] as CollectResult['marks'] }), false)).toHaveLength(1);
  });
  it('look-alikes: a mark, "all fields are required", a sentence naming the field, "(optional)" on the others, a choice, log-in and one-field forms', () => {
    const judgeWith = (over: Partial<ScannedField>[], f: ScannedForm = fm, m = [ask]) => demandedFindings(f, new Map(fs.map((x, i) => [x.ref, { ...x, ...over[i] }])), collect({ messages: m }), false);
    expect(judgeWith([{ requiredMark: true }, { requiredMark: true }, { requiredMark: true }])).toEqual([]);
    expect(judgeWith([{}, {}, {}], form({ fields: [0, 1, 2], allRequired: true }))).toEqual([]);
    expect(judgeWith([{}, {}, {}], form({ fields: [0, 1, 2], text: 'Your full name, street address and town are required.' }))).toEqual([]);
    expect(judgeWith([{}, {}, { label: 'Town (optional)' }], fm, [msg({ text: 'Enter your full name and street address.', names: [0, 1], inForm: true })])).toEqual([]);
    expect(judgeWith([{}, {}, {}], fm, [msg({ text: 'Enter your full name or street address.', names: [0, 1], inForm: true })])).toEqual([]);
    // Already `required` in markup: the static rule judges it.
    expect(judgeWith([{ required: true }, { required: true }, { required: true }])).toEqual([]);
    expect(demandedFindings(fm, byRef, collect({ messages: [ask] }), true)).toEqual([]);
    expect(demandedFindings(form({ fields: [0] }), byRef, collect({ messages: [ask] }), false)).toEqual([]);
    // A format the email check states, on an empty send, asks for a valid value, not for a required field (training r1,
    // a red-team look-alike): no finding for the field, nor for its aria-invalid mark.
    const em = new Map([[0, field({ ref: 0, label: 'Your name' })], [1, field({ ref: 1, label: 'Email address', type: 'email' })]]);
    expect(demandedFindings(form({ fields: [0, 1] }), em, collect({ messages: [msg({ text: 'Enter an email address in the form name@example.test.', assoc: [1], inForm: true })], marks: [{ ref: 1, aria: true, style: false, cls: false, icon: false }] as CollectResult['marks'] }), false)).toEqual([]);
    // Results are not demands.
    expect(demandedFindings(fm, byRef, collect({ messages: [msg({ text: 'No permits match that number.', names: [0] })] }), false)).toEqual([]);
  });
  it('requiredSaid: a sentence must name the field; the optional convention covers every other field', () => {
    expect(requiredSaid(field({ label: 'Email' }), form({ text: 'Name and email are required.' }))).toBe(true);
    expect(requiredSaid(field({ label: 'Phone' }), form({ text: 'Name and email are required.' }))).toBe(false);
    expect(requiredSaid(field({ label: 'Phone' }), form(), [field({ label: 'Middle name (optional)' })])).toBe(true);
  });
});

describe('D6/D7 3.3.7 sameness and availability (V-RE-06, -07, L-RE-06, -14; ruling Q1)', () => {
  const email1 = field({ ref: 0, type: 'email', label: 'Email for your review', autocomplete: 'email' });
  const v = 'grntedtest@example.invalid';
  const later = (over: Partial<ScannedField>) => [{ field: field({ ref: 9, type: 'email', label: 'Email for the decision letter', autocomplete: 'off', ...over }), value: '' }];
  const at = (p: 'none' | 'back' | 'maybe' | 'shown') => new Map([[0, p]] as const);
  it('RED: the same person\'s email in other words, nowhere on the page or only through Back, fails (strong proof)', () => {
    expect(redundantFindings([{ field: email1, value: v }], later({}), '', 2, at('none'))).toMatchObject([{ status: 'failed' }]);
    expect(redundantFindings([{ field: email1, value: v }], later({}), '', 2, at('back'))).toMatchObject([{ status: 'failed', detail: expect.stringContaining('going back') }]);
  });
  it('look-alikes: another party in the field or the step, a signature, two emails in the step, shown or maybe: never failed', () => {
    expect(redundantFindings([{ field: email1, value: v }], later({}), '', 2, at('none'), 'Second applicant')).not.toMatchObject([{ status: 'failed' }]);
    expect(redundantFindings([{ field: email1, value: v }], later({ label: 'Emergency contact email' }), '', 2, at('none'))).not.toMatchObject([{ status: 'failed' }]);
    const name1 = field({ ref: 0, label: 'Full name', autocomplete: 'name' });
    expect(redundantFindings([{ field: name1, value: 'Grntedtest Name' }], [{ field: field({ ref: 9, label: 'Type your full name to sign' }), value: '' }], '', 3, at('none'))).not.toMatchObject([{ status: 'failed' }]);
    const two = [...later({}), { field: field({ ref: 10, type: 'email', label: 'Copy to' }), value: '' }];
    expect(redundantFindings([{ field: email1, value: v }], two, '', 2, at('none')).some((f) => f.status === 'failed')).toBe(false);
    expect(redundantFindings([{ field: email1, value: v }], later({}), '', 2, at('shown'))).toEqual([]);
    expect(redundantFindings([{ field: email1, value: v }], later({}), '', 2, at('maybe'))).toMatchObject([{ status: 'not_testable' }]);
  });
  it('weak sameness (a matching label on a non-personal field) through Back is listed, not failed (ruling Q1)', () => {
    const code = field({ ref: 0, label: 'Program code' });
    expect(redundantFindings([{ field: code, value: 'AB-1234' }], [{ field: field({ ref: 9, label: 'Program code' }), value: '' }], '', 2, at('back'))).toMatchObject([{ status: 'not_testable' }]);
  });
  it('the step\'s own words asking again prove it', () => {
    const code = field({ ref: 0, label: 'Program code' });
    expect(redundantFindings([{ field: code, value: 'AB-1234' }], [{ field: field({ ref: 9, label: 'Program code' }), value: '' }], '', 2, at('none'), 'Enter the program code again for the roster.')).toMatchObject([{ status: 'failed' }]);
  });
});

describe('D21 1.3.5 purpose breadth (V-IP-09, -10, -11; L-IP-02, -14, -15)', () => {
  it('owner qualifiers, a legend over a part, and an email or phone type name the purpose', () => {
    expect(matchInputPurpose({ label: 'Applicant first name', type: 'text' })).toMatchObject({ kind: 'purpose', purpose: 'given-name' });
    expect(matchInputPurpose({ label: 'Email for receipts', type: 'text' })).toMatchObject({ kind: 'purpose', purpose: 'email' });
    expect(matchInputPurpose({ label: 'Month', type: 'select', legend: 'Date of birth' })).toMatchObject({ kind: 'purpose', purpose: 'bday-month' });
    // Fix round (Sol S3, lead's ruling): the type alone no longer names whose detail it is: a review case for the AI.
    expect(matchInputPurpose({ label: 'Where should we send updates?', type: 'email' })).toMatchObject({ kind: 'ambiguous' });
  });
  it('look-alikes: someone else\'s email or phone, and the address of a place, are not the person\'s', () => {
    expect(matchInputPurpose({ label: 'Your supervisor\'s email', type: 'email' }).kind).not.toBe('purpose');
    expect(matchInputPurpose({ label: 'Customer email', type: 'email' }).kind).not.toBe('purpose');
    expect(matchInputPurpose({ label: 'Phone', type: 'tel', legend: 'Emergency contact' }).kind).not.toBe('purpose');
    const page = { forms: [form({ fields: [0], name: 'Report a pothole', context: 'Tell us where the problem is.' })], fields: [field({ ref: 0, label: 'Address' })] };
    expect(purposeFindings(page).findings).toEqual([]);
    const home = { forms: [form({ fields: [0], name: 'Change your mailing address' })], fields: [field({ ref: 0, label: 'Address' })] };
    expect(purposeFindings(home).findings).toHaveLength(1);
  });
});

describe('D22 3.3.4 bank and frame payments, inline confirm (V-EP-02, -03, L-EP-11)', () => {
  const pay = (over: Partial<ScannedForm> = {}, fields = [field({ ref: 0, label: 'Routing number' }), field({ ref: 1, label: 'Bank account number' }), field({ ref: 2, label: 'Amount' })]) =>
    preventionFindings({ forms: [form({ fields: fields.map((f) => f.ref), submitter: { ref: 0, label: 'Submit payment', kind: 'submit' }, ...over })], fields });
  it('bank details paid on one press are listed, not failed (fix round, Sol S4); a provider\'s card frame in the form is a card payment and fails', () => {
    expect(pay().findings).toMatchObject([{ criterion: '3.3.4', status: 'not_testable', detail: expect.stringContaining('bank account details') }]);
    expect(pay({ cardFrame: true }, [field({ ref: 0, label: 'Amount' })]).findings).toMatchObject([{ status: 'failed' }]);
  });
  it('look-alike (Sol S4): card details, but the page holds a review it has not shown yet: listed, not failed', () => {
    const card = [field({ ref: 0, label: 'Card number', autocomplete: 'cc-number' }), field({ ref: 1, label: 'Amount' })];
    expect(pay({}, card).findings).toMatchObject([{ status: 'failed' }]);
    expect(pay({ reviewHeld: 'Check your payment details' }, card).findings).toMatchObject([{ status: 'not_testable', detail: expect.stringContaining('Check your payment details') }]);
  });
  it('look-alikes: an inline confirmation, a utility account number without bank details', () => {
    expect(pay({ confirmsInline: true }).findings).toEqual([]);
    expect(pay({}, [field({ ref: 0, label: 'Utility account number' }), field({ ref: 1, label: 'Amount' })]).findings).toEqual([]);
  });
});

describe('D23 3.3.8 authentication breadth (V-AU-03, -08, -11; L-AU-10)', () => {
  const login = (extra: ScannedField[] = []) => ({
    forms: [form({ fields: [0, 1, ...extra.map((f) => f.ref)], text: 'Sign in to pay your bill.' })],
    fields: [field({ ref: 0, label: 'User name', type: 'text' }), field({ ref: 1, label: 'Password', type: 'password' }), ...extra],
    altLogin: [],
  });
  it('a user-name field that refuses a paste is listed (fix round, Sol S6); a text field masked as a password counts as one and fails', () => {
    expect(authFindings(login(), new Map([[0, { blocked: true, via: 'paste' }]])).findings).toMatchObject([{ criterion: '3.3.8', status: 'not_testable', target: expect.stringContaining('User name') }]);
    const masked = { forms: [form({ fields: [0, 1] })], fields: [field({ ref: 0, label: 'User name' }), field({ ref: 1, label: 'Password', type: 'text' })], altLogin: [] };
    expect(authFindings(masked, new Map([[1, { blocked: true, via: 'cleared' }]])).findings).toMatchObject([{ status: 'failed', detail: expect.stringContaining('password') }]);
  });
  it('characters of a memorable word asked by position are listed for review, never failed (fix round, Sol S5)', () => {
    const page = { forms: [form({ fields: [0, 1, 2, 3], text: 'Enter characters from your memorable word.' })], fields: [
      field({ ref: 0, label: 'User name' }), field({ ref: 1, label: '2nd character', type: 'password', maxLength: 1 }), field({ ref: 2, label: '5th character', type: 'password', maxLength: 1 }), field({ ref: 3, label: '7th character', type: 'password', maxLength: 1 })], altLogin: [] };
    // Three one-character password fields asked by position are one log-in secret, not a sign-up's passwords.
    expect(authFindings(page, new Map()).findings).toMatchObject([{ criterion: '3.3.8', status: 'not_testable', detail: expect.stringContaining('by their position') }]);
  });
  it('look-alike (Sol S5): paste blocked in the password field while another way to sign in is offered is listed, not failed', () => {
    const page = { ...login(), altLogin: ['Email me a sign-in link'] };
    expect(authFindings(page, new Map([[1, { blocked: true, via: 'paste' }]])).findings).toMatchObject([{ status: 'not_testable', detail: expect.stringContaining('sign-in link') }]);
    expect(authFindings(login(), new Map([[1, { blocked: true, via: 'paste' }]])).findings).toMatchObject([{ status: 'failed' }]);
  });
  it('look-alike: a paste that goes through is no finding', () => {
    expect(authFindings(login(), new Map([[0, { blocked: false, via: '' }]])).findings).toEqual([]);
  });
});

describe('D11 3.3.3 messages that say only "wrong" (V-ES-03, -04, -05; L-ES-04, -07)', () => {
  it('restatesOnly: the field\'s own words with error words only', () => {
    expect(restatesOnly('Invalid date', field({ label: 'Date' }))).toBe(true);
    expect(restatesOnly('Parcel number not valid', field({ label: 'Parcel number' }))).toBe(true);
    expect(restatesOnly('Enter the date as MM/DD/YYYY', field({ label: 'Date' }))).toBe(false);
    expect(restatesOnly('Invalid', field({ label: 'Date' }))).toBe(false);
  });
  const date = field({ ref: 0, label: 'Start date', type: 'text' });
  const phone = field({ ref: 1, label: 'Phone', type: 'tel' });
  const fm = form({ fields: [0, 1], noValidate: true });
  const run = (o: Partial<Parameters<typeof judgeAttempt>[2]>, f: ScannedField[] = [date, phone], formatRefs = new Set([0, 1])) =>
    judgeAttempt(fm, new Map(f.map((x) => [x.ref, x])), collect(o), [], 'format', formatRefs).findings.filter((x) => x.criterion === '3.3.3');
  it('RED: "Invalid start date" for a date typed as text, with no format shown, fails', () => {
    expect(run({ messages: [msg({ text: 'Invalid start date', assoc: [0], near: 0, inForm: true })] })).toHaveLength(1);
  });
  it('RED: the browser\'s pattern message with no title, and a generic custom validity message, fail', () => {
    const pat = field({ ref: 0, label: 'Parcel', pattern: '\\d{3}-\\d{3}' });
    const f = [pat, phone];
    expect(judgeAttempt(form({ fields: [0, 1] }), new Map(f.map((x) => [x.ref, x])), collect({ invalid: [{ ref: 0, message: 'Please match the requested format.', prevented: false }] }), [], 'format', new Set([0])).findings.filter((x) => x.criterion === '3.3.3')).toHaveLength(1);
    expect(judgeAttempt(form({ fields: [0, 1] }), new Map(f.map((x) => [x.ref, x])), collect({ invalid: [{ ref: 1, message: 'Invalid', prevented: false }], reported: true }), [], 'format', new Set([1])).findings.filter((x) => x.criterion === '3.3.3')).toHaveLength(1);
  });
  it('look-alikes: a pattern with a title, a format shown by the field, an email\'s "valid email" message', () => {
    const titled = field({ ref: 0, label: 'Parcel', pattern: '\\d{3}-\\d{3}', title: '3 digits, a dash, 3 digits' });
    expect(judgeAttempt(form({ fields: [0] }), new Map([[0, titled]]), collect({ invalid: [{ ref: 0, message: 'Please match the requested format.', prevented: false }] }), [], 'format', new Set([0])).findings.filter((x) => x.criterion === '3.3.3')).toEqual([]);
    const hinted = field({ ref: 0, label: 'Start date (MM/DD/YYYY)', type: 'text' });
    expect(run({ messages: [msg({ text: 'Invalid start date', assoc: [0], near: 0, inForm: true })] }, [hinted, phone])).toEqual([]);
    const email = field({ ref: 0, label: 'Email', type: 'email' });
    expect(run({ messages: [msg({ text: 'Enter a valid email', assoc: [0], near: 0, inForm: true })] }, [email, phone])).toEqual([]);
  });
});

describe('fix round (out/reviews/b18-forms-sol-r1.md): the look-alike classes behind Sol\'s ten false failures', () => {
  const v = 'grntedtest@example.invalid';
  const at = new Map([[0, 'none']] as const);
  const email1 = (over: Partial<ScannedField> = {}) => field({ ref: 0, type: 'email', label: 'Email', autocomplete: 'email', ...over });
  const later = (over: Partial<ScannedField>) => [{ field: field({ ref: 9, type: 'email', label: 'Email', autocomplete: 'email', ...over }), value: '' }];
  it('S1: a person\'s detail of another kind or scope (work and home, current and new, "if different", a person the step asks about) is never proof', () => {
    expect(redundantFindings([{ field: email1({ label: 'Work email', autocomplete: 'work email' }), value: v }], later({ label: 'Home email', autocomplete: 'home email' }), '', 2, at)).toEqual([]);
    expect(redundantFindings([{ field: email1({ label: 'Work email', autocomplete: 'email' }), value: v }], later({ label: 'Home email' }), '', 2, at)).not.toMatchObject([{ status: 'failed' }]);
    expect(redundantFindings([{ field: email1({ label: 'Current email address' }), value: v }], later({ label: 'New email address' }), '', 2, at)).not.toMatchObject([{ status: 'failed' }]);
    expect(redundantFindings([{ field: email1(), value: v }], later({ label: 'Email (if different from above)' }), '', 2, at)).toEqual([]);
    expect(redundantFindings([{ field: email1(), value: v }], later({}), '', 2, at, 'Who should we contact about the decision?')).not.toMatchObject([{ status: 'failed' }]);
    // "Best email to reach you": which of the person's addresses is asked for is not known (it may be another): listed.
    expect(redundantFindings([{ field: email1({ label: 'Contact email' }), value: v }], later({ label: 'Best email to reach you', autocomplete: 'off' }), '', 2, at)).toMatchObject([{ status: 'not_testable' }]);
    const tel = field({ ref: 0, type: 'tel', label: 'Daytime phone', autocomplete: 'tel' });
    expect(redundantFindings([{ field: tel, value: '555-0100' }], [{ field: field({ ref: 9, type: 'tel', label: 'Evening phone', autocomplete: 'tel' }), value: '' }], '', 2, at)).not.toMatchObject([{ status: 'failed' }]);
  });
  it('S1 RED kept: the same email asked for another use ("for the decision letter") still fails', () => {
    expect(redundantFindings([{ field: email1({ label: 'Email for your review' }), value: v }], later({ label: 'Email for the decision letter', autocomplete: 'off' }), '', 2, at)).toMatchObject([{ status: 'failed' }]);
  });
  it('S12: a reuse control about something else ("Use my saved print settings") offers nothing; one that names nothing else, or this answer, does', () => {
    const run = (sameAs: string) => redundantFindings([{ field: email1({ label: 'Contact email' }), value: v }], later({ label: 'Contact email again' }), sameAs, 2, at);
    expect(run('Use my saved print settings')).toMatchObject([{ status: 'failed' }]);
    expect(run('Same as mailing address')).toMatchObject([{ status: 'failed' }]);
    expect(run('Same as above')).toEqual([]);
    expect(run('Use my saved contact email')).toEqual([]);
  });
  it('S7: a number and a noun the choice rewrote ("90 days") is no status; the controls test\'s status words still are', () => {
    const c = (text: string): CollectResult => collect({ messages: [msg({ text, kind: 'text', inForm: true })] });
    expect(choiceStatus(c('90 days'), 'x', 'choosing "Quarterly"')).toBeNull();
    expect(choiceStatus(c('7 parks'), 'x', 'choosing "Pool"')).toBeNull();
    expect(choiceStatus(c('Showing 8 of 42 results'), 'x', 'choosing "Pool"')).toMatchObject({ status: 'failed' });
  });
  it('S8: a generic message for a field that shows its format (a hint, a title, a range in its label) is listed, not failed', () => {
    const hinted = field({ ref: 0, label: 'Permit identifier', pattern: '[A-Z]{2}[0-9]{6}', hint: 'Use two uppercase letters followed by six digits.' });
    const bare = field({ ref: 0, label: 'Permit identifier', pattern: '[A-Z]{2}[0-9]{6}' });
    const j = (f: ScannedField, o: Partial<CollectResult>) => judgeAttempt(form({ fields: [0] }), new Map([[0, f]]), collect(o), [], 'format', new Set([0])).findings.filter((x) => x.criterion === '3.3.3');
    expect(j(hinted, { invalid: [{ ref: 0, message: 'Invalid', prevented: false }], reported: true })).toMatchObject([{ status: 'not_testable' }]);
    expect(j(bare, { invalid: [{ ref: 0, message: 'Invalid', prevented: false }], reported: true })).toMatchObject([{ status: 'failed' }]);
    const nights = field({ ref: 0, label: 'Nights (1-12)', type: 'number', min: '1', max: '12' });
    expect(j(nights, { messages: [msg({ text: 'Invalid', assoc: [0], near: 0, inForm: true })] })).toMatchObject([{ status: 'not_testable' }]);
    expect(j({ ...nights, label: 'Number of nights' }, { messages: [msg({ text: 'Invalid', assoc: [0], near: 0, inForm: true })] })).toMatchObject([{ status: 'failed' }]);
  });
  it('S15: a number field is tried with a number past its range, not with letters the browser drops', () => {
    expect(invalidValue(field({ type: 'number', min: '1', max: '12' }))).toBe('24');
    expect(invalidValue(field({ type: 'number', min: '5' }))).toBe('-5');
  });
  it('S17: a required sentence names a field by a word of its own, not by a word many fields share', () => {
    const fm = form({ text: 'Account number is required.' });
    expect(requiredSaid(field({ label: 'Account number' }), fm)).toBe(true);
    expect(requiredSaid(field({ label: 'Phone number' }), fm)).toBe(false);
    expect(requiredSaid(field({ label: 'Full name' }), form({ text: 'Name and email are required.' }))).toBe(true);
    expect(requiredSaid(field({ label: 'Mailing address' }), form({ text: 'Email address is required.' }))).toBe(false);
  });
  it('S3: a personal field in a form named for someone else (an emergency contact) is a review case, never failed', () => {
    const page = { forms: [form({ fields: [0], name: 'Emergency contact' })], fields: [field({ ref: 0, label: 'Email address', type: 'email' })] };
    const r = purposeFindings(page);
    expect(r.findings).toEqual([]);
    expect(r.review.has(0)).toBe(true);
    const own = { forms: [form({ fields: [0], name: 'Contact us' })], fields: [field({ ref: 0, label: 'Email address', type: 'email' })] };
    expect(purposeFindings(own).findings).toHaveLength(1);
  });
  it('3.2.2 advised beforehand, broader wording (blind round A false alarm, precision): "the list updates as you choose" advises; "Go to a department", "Quick links" do not', () => {
    const f = (over: Partial<ScannedField>) => field({ type: 'select', label: 'Department', ...over });
    const fm = form({ text: '', context: '' });
    expect(advisedBy(f({ after: 'The results update as you choose.' }), fm)).not.toBe('');
    expect(advisedBy(f({ hint: 'Choosing a language translates the page.' }), fm)).not.toBe('');
    expect(advisedBy(f({ label: 'Choose a month (the calendar updates when you select one)' }), fm)).not.toBe('');
    expect(advisedBy(f({ label: 'Go to a department' }), fm)).toBe('');
    expect(advisedBy(f({ label: 'Quick links' }), fm)).toBe('');
  });
  it('S10 (atlas D3): a difference that does not show at one width follows the width: no failure; one that does stands', () => {
    const fail = { criterion: '1.3.4', status: 'failed' as const, detail: 'On a phone in portrait (390×844 px), most of its text is hidden' };
    const none: never[] = [];
    expect(confirmOrientation([fail], none, none)).toMatchObject([{ status: 'no_failures_found' }]);
    expect(confirmOrientation([fail], [fail], none)).toMatchObject([{ status: 'failed' }]);
    expect(confirmOrientation([fail], none, [fail])).toMatchObject([{ status: 'failed' }]);
    expect(confirmOrientation([fail], null, null)).toMatchObject([{ status: 'not_testable' }]);
    const land = { ...fail, detail: 'On a phone in landscape (844×390 px), its main content is hidden' };
    expect(confirmOrientation([land], [fail], none)).toMatchObject([{ status: 'no_failures_found' }]);
  });
});

describe('precision fix (lead, 2026-11-13 blind grade): no failure rests on not finding recognised wording when the form says things the test cannot classify', () => {
  const two = (over: Partial<ScannedField> = {}, fover: Partial<ScannedForm> = {}) => {
    const fields = [field({ ref: 0, label: 'Full name', required: true, ...over }), field({ ref: 1, label: 'Street address', required: true })];
    return { forms: [form({ fields: [0, 1], text: 'Full name Street address Send', buttons: ['Send'], ...fover })], fields };
  };
  const req = (p: ReturnType<typeof two>) => labelFindings(p).findings.filter((f) => f.criterion === '3.3.2');
  it('RED kept: required fields with nothing on the form at all still fail (minor)', () => {
    expect(req(two())).toMatchObject([{ status: 'failed', minor: true }, { status: 'failed', minor: true }]);
  });
  it('an instruction inside the form in words no rule reads ("Tell us about yourself", "Please answer every question") leaves it undecided', () => {
    for (const t of ['Tell us a little about yourself before we start.', 'Please answer every question so we can process the card.', 'We cannot issue a card without these details.']) {
      const r = req(two({}, { text: `${t} Full name Street address Send` }));
      expect(r.some((f) => f.status === 'failed'), t).toBe(false);
      expect(r.every((f) => f.status === 'not_testable'), t).toBe(true);
    }
  });
  it('words about filling in by the field (its hint, the text after it) or before the form leave it undecided; an unrelated intro before the form does not', () => {
    expect(req(two({ hint: 'You must give the name on your ID.' })).find((f) => f.target?.includes('Full name'))).toMatchObject({ status: 'not_testable' });
    expect(req(two({}, { context: 'Every box below has to be filled in.' })).every((f) => f.status === 'not_testable')).toBe(true);
    expect(req(two({}, { context: 'Send the office a message and we will answer within two days.' })).every((f) => f.status === 'failed')).toBe(true);
    // "Starting" is no star (training NG-125's "Tell us where you are starting and where you want to go").
    expect(req(two({}, { context: 'Tell us where you are starting and where you want to go.' })).every((f) => f.status === 'failed')).toBe(true);
    expect(req(two({}, { context: 'Questions with a star must be answered.' })).every((f) => f.status === 'not_testable')).toBe(true);
  });
  it('demanded on sending: the same (D8)', () => {
    const fm = form({ fields: [0, 1], noValidate: true, text: 'Leave nothing out. Full name Street address Send', buttons: ['Send'] });
    const fields = new Map([[0, field({ ref: 0, label: 'Full name' })], [1, field({ ref: 1, label: 'Street address' })]]);
    const r = demandedFindings(fm, fields, collect({ invalid: [{ ref: 0, message: '', prevented: true }, { ref: 1, message: '', prevented: true }] }), false);
    expect(r.length).toBe(2);
    expect(r.every((f) => f.status === 'not_testable')).toBe(true);
  });
  it('G167: a button whose words are not all an action\'s may name the field in other words: undecided, not failed', () => {
    expect(buttonCoverage('ZIP code', 'Find by postcode')).toBe('some');
    expect(buttonCoverage('Email address', 'Subscribe')).toBe('none');
    expect(buttonCoverage('Email', 'Request callback')).toBe('none');
  });
  it('3.3.3: text after the field, words in brackets in its label, or an instruction inside the form count as showing what it expects', () => {
    expect(formatShownBy(field({ label: 'Permit' }))).toBe('');
    expect(formatShownBy(field({ label: 'Permit', after: 'two capitals then six numerals' } as Partial<ScannedField>))).not.toBe('');
    expect(formatShownBy(field({ label: 'Permit (two capitals, six numerals)' }))).not.toBe('');
    expect(formatShownBy(field({ label: 'Permit (required)' }))).toBe('');
    expect(formatShownBy(field({ label: 'Permit' }), [], ['Permits are written as two capitals and six numerals'])).not.toBe('');
  });
  it('3.3.1: a symbol beside the field with another message on the page, or a form instruction, is undecided; alone it fails', () => {
    const f0 = field({ ref: 0, label: 'Your name' });
    const fm = form({ fields: [0], noValidate: true });
    const mark = { ref: 0, aria: false, style: false, cls: false, icon: true, symbol: true as const };
    const j = (o: Partial<CollectResult>, f = fm) => judgeAttempt(f, new Map([[0, f0]]), collect(o), [], 'empty').findings.filter((x) => x.criterion === '3.3.1');
    expect(j({ marks: [mark] })).toMatchObject([{ status: 'failed' }]);
    expect(j({ marks: [mark], messages: [msg({ text: 'Fields marked * still need an answer.', near: -1, inForm: true })] }).some((x) => x.status === 'failed' && x.target?.includes('Your name'))).toBe(false);
    expect(j({ marks: [mark] }, form({ fields: [0], noValidate: true, text: 'A star shows what is still missing. Your name' })).some((x) => x.status === 'failed')).toBe(false);
  });
});
