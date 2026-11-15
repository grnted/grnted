// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The form probes' pure judging (src/probes/forms.ts). The in-page half and the probes themselves
// are tested in Chromium (test/integration/forms.test.ts).
import { describe, expect, it } from 'vitest';
import {
  FORM_FIELDS_CRITERIA, FORMS_CRITERIA, PASTE_TEXT, SERVER_ONLY, TEST_MARK, attemptAnswer, authFindings, fitEvidence, isSensitiveField, formFieldsProbe, formSig, formsProbe, invalidValue, isGenericError, judgeAttempt, judgeValid, stoppedAny, unidentifiedError,
  judgeOnInput, labelFindings, preventionFindings, purposeFindings, redundantFindings, sentData, syntheticValue, validationSkip,
} from '../../src/probes/forms.js';
import type { CollectResult, ObserveResult, ScannedField, ScannedForm } from '../../src/probes/formsPage.js';
import { parseAutocomplete } from '../../src/probes/inputPurpose.js';
import { PROBES } from '../../src/probes/registry.js';
import { PROBE_DATA_MAX_CHARS } from '../../src/probes/runner.js';
import type { GuardEvent } from '../../src/probes/types.js';
import { CRITERIA } from '../../src/report/criteria.js';

const field = (over: Partial<ScannedField> = {}): ScannedField => ({
  ref: 0, form: 0, tag: 'input', type: 'text', name: '', id: '', label: 'Name', legend: '', placeholder: '', autocomplete: null, required: false,
  pattern: '', title: '', minLength: -1, maxLength: -1, min: '', max: '', inputMode: '', shown: true, disabled: false, readOnly: false, group: '',
  hint: '', errorArea: false, visibleLabel: true, nearby: '', requiredMark: false, checked: false, options: 0, ...over,
});
const form = (over: Partial<ScannedForm> = {}): ScannedForm => ({
  index: 0, kind: 'form', name: 'Contact', context: '', text: '', method: 'post', action: 'https://e.org/contact', target: '', noValidate: false,
  search: false, fields: [0], fieldCount: 1, submitter: { ref: 0, label: 'Send', kind: 'submit' }, buttons: ['Send'], next: null, hiddenFields: 0,
  captcha: [], allRequired: false, ...over,
});
const collect = (over: Partial<CollectResult> = {}): CollectResult => ({
  submits: [], protoSubmits: [], opens: 0, net: [], invalid: [], reported: false, formGone: false, messages: [], marks: [], announcements: [],
  active: { to: 'body', ref: -1, form: -1, label: '' }, activeBefore: { to: 'body', ref: -1, form: -1, label: '' }, focusMoved: false, ...over,
});
const observe = (over: Partial<ObserveResult> = {}): ObserveResult => ({
  submits: [], protoSubmits: [], opens: 0, net: [], url: 'https://e.org/', active: { to: 'body', ref: -1, form: -1, label: '' }, ...over,
});
const ev = (e: Partial<GuardEvent>): GuardEvent => ({ kind: 'blocked', at: 0, ...e });

describe('the form probes', () => {
  it('are registered: form-fields core (sharing its page), forms deep and isolated, both with the strict guard', () => {
    expect(PROBES).toContain(formFieldsProbe);
    expect(PROBES).toContain(formsProbe);
    expect(formFieldsProbe).toMatchObject({ id: 'form-fields', tier: 'core', sendsNothing: true, criteria: ['1.3.1', '1.3.5', '3.3.2', '3.3.4', '3.3.8'] });
    expect(formFieldsProbe.isolate).toBeFalsy();
    expect(formsProbe).toMatchObject({ id: 'forms', tier: 'deep', isolate: true, sendsNothing: true, criteria: ['3.2.2', '3.3.1', '3.3.2', '3.3.3', '3.3.7', '4.1.3'] });
  });

  it('every criterion of Task 4.6 declares its probe in the criteria table', () => {
    for (const [probe, list] of [['form-fields', FORM_FIELDS_CRITERIA], ['forms', FORMS_CRITERIA]] as const) {
      for (const c of list) expect(CRITERIA.find((d) => d.criterion === c)!.methods).toContain(`probe:${probe}`);
    }
    for (const c of ['1.3.5', '3.3.3', '3.3.4', '3.3.8']) expect(CRITERIA.find((d) => d.criterion === c)!.methods).toContain('ai:forms');
  });
});

describe('sentData', () => {
  it('a held navigation, a popup or a blocked request that is not a static file means the page tried to send', () => {
    expect(sentData([ev({ kind: 'navigation' })])).toBe(true);
    expect(sentData([ev({ kind: 'popup' })])).toBe(true);
    expect(sentData([ev({ reason: 'method', resourceType: 'fetch' })])).toBe(true);
    expect(sentData([ev({ reason: 'data', resourceType: 'xhr' })])).toBe(true);
    // A lazy image with a query string, stopped by the strict guard, is not the form sending.
    expect(sentData([ev({ reason: 'data', resourceType: 'image' })])).toBe(false);
    expect(sentData([ev({ kind: 'dialog' }), ev({ kind: 'url-change' })])).toBe(false);
    // Strict-mode blocks unrelated to the form: a late iframe, a socket-like request, a static file at an action address.
    expect(sentData([ev({ reason: 'data', resourceType: 'document' })])).toBe(false);
    expect(sentData([ev({ reason: 'data', resourceType: 'other' })])).toBe(false);
    expect(sentData([ev({ reason: 'action', resourceType: 'script', url: 'https://e.org/assets/cart.js' })])).toBe(false);
    for (const resourceType of ['fetch', 'xhr', 'ping', 'beacon', 'eventsource']) expect(sentData([ev({ reason: 'data', resourceType })])).toBe(true);
    expect(sentData([ev({ reason: 'action', resourceType: 'xhr' })])).toBe(true);
    // A blocked frame document counts when this attempt also submitted the form (a form with a frame target).
    expect(sentData([ev({ reason: 'data', resourceType: 'document' })], { submitted: true })).toBe(true);
  });
});

describe('act-watch (2026-11-11, review r1): the item in error not identified, no suggestion, and the filled-in attempt', () => {
  const msg = (text: string, o: object = {}) => ({ text, kind: 'added' as const, near: -1, assoc: [] as number[], names: [] as number[], live: false, focus: false, ...o });
  const email = field({ ref: 0, type: 'email', label: 'Email address' });
  const route = field({ ref: 1, type: 'checkbox', label: 'Library news', group: 'topic', legend: 'Topics' });
  const pool = field({ ref: 2, type: 'checkbox', label: 'Pool hours', group: 'topic', legend: 'Topics' });
  const fields = new Map([[0, email], [1, route], [2, pool]]);
  const f = form({ fields: [0, 1, 2], noValidate: true, submitter: { ref: 0, label: 'Update alerts', kind: 'submit' } });
  const ids = (r: { findings: { criterion: string; status: string }[] }) => r.findings.filter((x) => x.status === 'failed').map((x) => x.criterion);
  const toast = (text: string, o: object = {}) => msg(text, { outside: true, direct: true, ...o });

  it('3.3.1: an error the submit wrote that names no field, with nothing marked, is a candidate (it stands when the form takes the filled-in values)', () => {
    const r = judgeAttempt(f, fields, collect({ messages: [toast('Could not update your alerts.')] }), [], 'empty');
    expect(r.findings.filter((x) => x.criterion === '3.3.1')).toEqual([]);
    expect(r.unidentified).toEqual({
      criterion: '3.3.1', status: 'failed', target: 'form "Contact"',
      detail: 'submitted with its fields empty, the form answers "Could not update your alerts.": it says something is wrong but not where; it names none of the form\'s 2 fields, is tied to none, and no field is marked as wrong (the same form takes the values when they are filled in)',
    });
    // Inside the form, not written by the submit's own events: judged too (the form's own area).
    expect(unidentifiedError(f, fields, collect({ messages: [msg('Something went wrong. Try again.', { inForm: true })] }), [], 'format')).not.toBeNull();
  });

  it('3.3.1 look-alikes (review r1 F3b, F4, F5): nothing is judged unless the message is the form\'s and names nothing about any field', () => {
    const none = (o: Partial<CollectResult>, g: ReturnType<typeof ev>[] = [], frm = f, fl = fields) => expect(unidentifiedError(frm, fl, collect(o), g, 'empty')).toBeNull();
    // Outside the form and not written by the submit (a rotating notice, a late prompt); churned; in a shadow tree.
    none({ messages: [msg('Sorry, the chat is offline.', { outside: true })] });
    none({ messages: [toast('Could not update your alerts.', { churned: true })] });
    none({ messages: [toast('Could not update your alerts.', { unsure: true })] });
    // Named by a group's legend (a plural read as its singular), by the type's word, by an autocomplete purpose.
    none({ messages: [toast('Choose at least one topic.')] });
    none({ messages: [toast('That e-mail does not look right.')] });
    const zip = field({ ref: 3, label: 'ZIP', name: 'zip', autocomplete: 'postal-code' });
    none({ messages: [toast('Enter a valid postal code.')] }, [], form({ fields: [0, 3] }), new Map([[0, email], [3, zip]]));
    // Focus moved to a field; a CAPTCHA on the form; one group of choices only; a request the guard stopped (JSONP).
    none({ messages: [toast('Could not update your alerts.')], focusMoved: true, active: { to: 'field', ref: 0, form: 0, label: 'Email address' } });
    none({ messages: [toast('Please complete the check below.')] }, [], form({ fields: [0, 1, 2], captcha: [{ kind: 'widget', name: 'reCAPTCHA' }] as never }));
    none({ messages: [toast('Could not update your alerts.')] }, [], form({ fields: [1, 2] }));
    none({ messages: [toast('Could not connect. Please try again.')] }, [ev({ resourceType: 'script', url: 'https://e.org/subscribe?callback=cb' })]);
    // Tied, named or linked; a field marked; the browser found one invalid; the fields as a group; a lookup's result.
    none({ messages: [toast('Could not update your alerts.'), msg('Enter an email address', { assoc: [0], inForm: true })] });
    none({ messages: [toast('Could not update your alerts.')], marks: [{ ref: 0, aria: true, style: false, cls: false, icon: false }] });
    none({ messages: [toast('Could not update your alerts.')], invalid: [{ ref: 0, message: 'x', prevented: true }] });
    for (const text of ['Please fill in all required fields.', 'Check the fields marked below and try again.', 'No account found for those details.']) none({ messages: [toast(text)] });
  });

  it('3.3.3: a stated format the page marks as wrong, with no words about the field at all (shown, not assumed), fails; any words, an example after it, a stopped request do not', () => {
    const name = field({ ref: 1, label: 'Your name' });
    const two = new Map([[0, email], [1, name]]);
    const g = form({ fields: [0, 1], noValidate: true });
    const kept = { ref: 0, aria: false, style: false, cls: true, icon: false, kept: true as const };
    const rows = (quiet: boolean, text = 'Email address') => [{ ref: 0, quiet, text }, { ref: 1, quiet: true, text: 'Your name' }];
    expect(judgeAttempt(g, two, collect({ marks: [kept], rows: rows(true) }), [], 'format', new Set([0])).findings.find((x) => x.criterion === '3.3.3')).toEqual({
      criterion: '3.3.3', status: 'failed', target: 'Email address (email field)',
      detail: 'after a value in the wrong format, the page marks "Email address" as wrong but shows no text at all: nothing says what is expected (an email address such as name@example.com)',
    });
    const no333 = (x: ReturnType<typeof judgeAttempt>) => expect(x.findings.filter((y) => y.criterion === '3.3.3' && y.status === 'failed')).toEqual([]);
    // Absence not shown (words around the field differ from the first attempt's, F1); no row facts at all.
    no333(judgeAttempt(g, two, collect({ marks: [kept], rows: rows(false) }), [], 'format', new Set([0])));
    no333(judgeAttempt(g, two, collect({ marks: [kept] }), [], 'format', new Set([0])));
    // An example after the field, in its row (F1); a hint before it; the browser's message; a stopped request (F5).
    no333(judgeAttempt(g, two, collect({ marks: [kept], rows: rows(true, 'Email address e.g. name@example.com') }), [], 'format', new Set([0])));
    no333(judgeAttempt(g, new Map([[0, field({ ...email, hint: 'For example name@example.com' })], [1, name]]), collect({ marks: [kept], rows: rows(true) }), [], 'format', new Set([0])));
    no333(judgeAttempt(form({ fields: [0, 1] }), two, collect({ invalid: [{ ref: 0, message: "Please include an '@'", prevented: false }], rows: rows(true) }), [], 'format', new Set([0])));
    no333(judgeAttempt(g, two, collect({ marks: [kept], rows: rows(true) }), [ev({ resourceType: 'image', url: 'https://e.org/px.gif' })], 'format', new Set([0])));
    // The empty attempt; a field not marked; any message.
    no333(judgeAttempt(g, two, collect({ marks: [kept], rows: rows(true) }), [], 'empty'));
    no333(judgeAttempt(g, two, collect({ marks: [{ ...kept, ref: 1 }], rows: rows(true) }), [], 'format', new Set([0])));
    no333(judgeAttempt(g, two, collect({ marks: [kept], rows: rows(true), messages: [msg('Check your entries', { near: 0, inForm: true })] }), [], 'format', new Set([0])));
  });

  it('the filled-in attempt: a short message of the form nobody is told about fails 4.1.3; announced, late-announced, focused, refused, outside or churned does not', () => {
    const v = judgeValid(f, collect({ messages: [msg('Your report is ready to review.', { near: 0, inForm: true })] }), []);
    expect(v).toEqual({ outcome: 'client', findings: [{
      criterion: '4.1.3', status: 'failed', target: 'form "Contact"',
      detail: 'filled in with test values and sent (nothing left the browser), the form showed "Your report is ready to review.", a status message screen readers are not told about: it is in no live region or alert, and focus stayed on "Update alerts"',
    }] });
    expect(judgeValid(f, collect({ messages: [toast('Your alert settings are updated.')] }), []).findings[0]!.detail).toContain('elsewhere on the page');
    const clean = (o: Partial<CollectResult>, late = false) => expect(judgeValid(f, collect(o), [], { late }).findings.map((x) => x.status)).toEqual(['no_failures_found']);
    const saved = msg('Settings saved.', { inForm: true });
    clean({ messages: [{ ...saved, live: true }] });
    clean({ messages: [{ ...saved, focus: true }] });
    clean({ messages: [saved], focusMoved: true });
    clean({ messages: [saved], announcements: ['Settings saved.'] });
    clean({ messages: [saved] }, true);
    const nothing = (o: Partial<CollectResult>, g: ReturnType<typeof ev>[] = []) => expect(judgeValid(f, collect(o), g).findings).toEqual([]);
    // Outside the form and not written by the submit; churned; in a shadow tree that holds a live region.
    nothing({ messages: [msg('Library hours updated', { outside: true })] });
    nothing({ messages: [{ ...saved, churned: true }] });
    nothing({ messages: [{ ...saved, unsure: true }] });
    // The page refused the test values (F8): an error by its words, a mark, a field found invalid.
    expect(judgeValid(f, collect({ messages: [msg('Enter your password', { inForm: true })] }), [])).toMatchObject({ outcome: 'rejected', findings: [] });
    expect(judgeValid(f, collect({ messages: [saved], marks: [{ ref: 0, aria: true, style: false, cls: false, icon: false }] }), [])).toMatchObject({ outcome: 'rejected', findings: [] });
    // An error-worded notice in the form's area that is not the form's answer (not in the form, by a field or written
    // by the submit: a rotating line that changed in the window) refuses nothing; the form's own message is judged.
    expect(judgeValid(f, collect({ messages: [msg('Thanks, your request was received.', { direct: true }), msg('Road closed, please use Main Street')] }), []))
      .toMatchObject({ outcome: 'client', findings: [{ criterion: '4.1.3', status: 'failed' }] });
    // Nothing judged: no message, a section, a long text; any request the guard stopped (a script too, F5); a dialog; the form gone.
    expect(judgeValid(f, collect(), [])).toMatchObject({ outcome: 'silent', findings: [] });
    nothing({ messages: [msg('Review your bill', { parts: true, inForm: true })] });
    nothing({ messages: [msg('x'.repeat(251), { inForm: true })] });
    expect(judgeValid(f, collect({ messages: [saved] }), [ev({ resourceType: 'script', url: 'https://e.org/cb.js' })])).toMatchObject({ outcome: 'server', findings: [] });
    expect(judgeValid(f, collect({ messages: [saved], net: [{ api: 'fetch', method: 'POST', url: '/save' }] }), [])).toMatchObject({ outcome: 'server', findings: [] });
    expect(judgeValid(f, collect({ messages: [saved], submits: [{ form: 0, prevented: false }] }), [])).toMatchObject({ outcome: 'server', findings: [] });
    expect(judgeValid(f, collect({ messages: [saved] }), [ev({ kind: 'dialog' })])).toMatchObject({ outcome: 'stopped', findings: [] });
    expect(judgeValid(f, collect({ formGone: true, messages: [saved] }), [])).toMatchObject({ outcome: 'silent', findings: [] });
    expect(stoppedAny([ev({ cause: 'background' })])).toBe(false);
  });
});

describe('judgeAttempt', () => {
  const name = field({ ref: 0, label: 'Name', required: true });
  const email = field({ ref: 1, type: 'email', label: 'Email' });
  const fields = new Map([[0, name], [1, email]]);
  const f = form({ fields: [0, 1] });

  it('a form whose answers would leave is "server", with the reason, and nothing judged', () => {
    for (const obs of [collect({ net: [{ api: 'fetch', method: 'POST', url: '/x' }] }), collect({ protoSubmits: [0] }), collect({ submits: [{ form: 0, prevented: false }] })]) {
      expect(judgeAttempt(f, fields, obs, [], 'empty')).toMatchObject({ outcome: 'server', reason: SERVER_ONLY, findings: [] });
    }
    expect(judgeAttempt(f, fields, collect(), [ev({ kind: 'navigation' })], 'empty').outcome).toBe('server');
    expect(judgeAttempt(f, fields, collect(), [ev({ kind: 'dialog' })], 'empty').outcome).toBe('stopped');
  });

  it('the browser\'s own messages count for a real submit or reportValidity(), not for a silent checkValidity()', () => {
    const invalid = [{ ref: 0, message: 'Please fill out this field.', prevented: false }];
    expect(judgeAttempt(f, fields, collect({ invalid }), [], 'empty')).toMatchObject({ outcome: 'client', findings: [], seen: { native: 1 } });
    const button = form({ fields: [0, 1], submitter: { ref: 0, label: 'Send request', kind: 'button' } });
    expect(judgeAttempt(button, fields, collect({ invalid, reported: true }), [], 'empty')).toMatchObject({ outcome: 'client', findings: [] });
    const silent = judgeAttempt(button, fields, collect({ invalid }), [], 'empty');
    expect(silent.findings).toEqual([{
      criterion: '3.3.1', status: 'failed', target: 'form "Contact"',
      detail: 'pressing "Send request" with the required fields empty did nothing visible: the page found 1 field not filled in correctly but showed no message saying which or why',
    }]);
    expect(judgeAttempt(form({ fields: [0, 1], noValidate: true }), fields, collect({ invalid }), [], 'empty').findings[0]!.criterion).toBe('3.3.1');
    expect(judgeAttempt(f, fields, collect(), [], 'empty')).toMatchObject({ outcome: 'silent', findings: [] });
    expect(judgeAttempt(f, fields, collect({ formGone: true, messages: [] }), [], 'format')).toMatchObject({ outcome: 'silent', reason: expect.stringContaining('page replaced') });
  });

  it('3.3.1: a message not tied to its field, and a colour-only mark, fail; tied or naming messages do not', () => {
    const msg = (text: string, o: object = {}) => ({ text, kind: 'added' as const, near: 0, assoc: [] as number[], names: [] as number[], live: false, focus: false, ...o });
    const r = judgeAttempt(f, fields, collect({ messages: [msg('This field is required.')], marks: [{ ref: 1, aria: false, style: true, cls: false, icon: false }] }), [], 'empty');
    expect(r.findings.map((x) => [x.criterion, x.target])).toEqual([['3.3.1', 'Name (text field)'], ['3.3.1', 'Email (email field)'], ['4.1.3', 'form "Contact"']]);
    const ok = judgeAttempt(f, fields, collect({ messages: [msg('Enter your name', { assoc: [0], live: true }), msg('Name is required', { near: 1, names: [0] })] }), [], 'empty');
    expect(ok.findings).toEqual([]);
    // An unrelated iframe the strict guard stopped during the attempt does not hide a real failure.
    const iframe = [ev({ reason: 'data', resourceType: 'document', url: 'https://maps.example/embed' })];
    const kept = judgeAttempt(f, fields, collect({ messages: [msg('This field is required.')] }), iframe, 'empty');
    expect(kept.outcome).toBe('client');
    expect(kept.findings.map((x) => x.criterion)).toEqual(['3.3.1', '4.1.3']);
    expect(judgeAttempt(f, fields, collect({ submits: [{ form: 0, prevented: false }] }), iframe, 'empty').outcome).toBe('server');
    // An error summary outside the form (near -1) belongs to no field and is not judged as untied (here the field's
    // own error, tied to it, says which field; without it the form identifies nothing, a failure of its own below).
    expect(judgeAttempt(f, fields, collect({ messages: [msg('There is a problem', { near: -1, live: true }), msg('Enter your name', { assoc: [0], live: true })] }), [], 'empty').findings).toEqual([]);
  });

  it('3.3.1: a message shown after the form is sent that is no error (a confirmation, a result) is not an untied error', () => {
    const msg = (text: string, o: object = {}) => ({ text, kind: 'added' as const, near: 0, assoc: [] as number[], names: [] as number[], live: false, focus: false, ...o });
    const untied = (r: ReturnType<typeof judgeAttempt>) => r.findings.filter((x) => x.criterion === '3.3.1');
    // The form took the empty attempt and answered with a confirmation or a result next to its fields: no field is
    // marked as wrong, the browser found none invalid, and the words are not an error's.
    for (const text of ['Request received. A specialist will confirm your start date.', 'Thanks! Your estimate is ready: 3 bags a month.', 'Your sample request is ready. No information was sent.', 'Saved. You can close this page.']) {
      const r = judgeAttempt(f, fields, collect({ messages: [msg(text)] }), [], 'empty');
      expect(untied(r), text).toEqual([]);
      // It is still a status message: shown and not announced fails 4.1.3.
      expect(r.findings.map((x) => x.criterion), text).toEqual(['4.1.3']);
    }
    // Look-alikes that are still untied errors: an error by its words, in English or not; and any message once a field is marked as wrong.
    for (const text of ['This field is required.', 'Enter your full name', 'The answer is incorrect. Try again.', 'Please select a date', 'Este campo es obligatorio', 'Invalid']) {
      expect(untied(judgeAttempt(f, fields, collect({ messages: [msg(text)] }), [], 'empty')).map((x) => x.target), text).toEqual(['Name (text field)']);
    }
    const marked = judgeAttempt(f, fields, collect({ messages: [msg('Check the highlighted answer')], marks: [{ ref: 0, aria: true, style: false, cls: false, icon: false }] }), [], 'empty');
    expect(untied(marked).map((x) => x.target)).toEqual(['Name (text field)']);
  });

  // A page-level error summary inside the form, beside the fields' own tied errors (grnted.co's contact
  // form; GOV.UK's error summary, which links to the fields): correct practice, never an untied error.
  describe('3.3.1: an error summary with the fields\' own tied errors', () => {
    const msg = (text: string, o: object = {}) => ({ text, kind: 'added' as const, near: 0, assoc: [] as number[], names: [] as number[], live: false, focus: false, ...o });
    const summary = msg('Please fix the details below.', { live: true });
    const nameErr = msg('Enter your name', { assoc: [0] });
    const emailErr = msg('Enter an email address', { near: 1, assoc: [1] });
    const aria = (ref: number) => ({ ref, aria: true, style: false, cls: false, icon: false });
    const untied = (r: ReturnType<typeof judgeAttempt>) => r.findings.filter((x) => x.criterion === '3.3.1');

    it('RED (real scan): a summary alert beside fields whose errors are tied to them (aria-describedby) passes', () => {
      expect(untied(judgeAttempt(f, fields, collect({ messages: [summary, nameErr, emailErr], marks: [aria(0), aria(1)] }), [], 'empty'))).toEqual([]);
      // Its nearest field may be one with no error at all (the summary sits above an optional field).
      expect(untied(judgeAttempt(f, fields, collect({ messages: [msg('Please fix the details below.', { near: 1, live: true }), nameErr], marks: [aria(0)] }), [], 'empty'))).toEqual([]);
    });

    it('RED (real scan): a GOV.UK error summary that links to the fields passes, with or without the fields\' own messages', () => {
      const gov = msg('There is a problem Enter your name Enter an email address', { live: true, focus: true, links: [0, 1] });
      expect(untied(judgeAttempt(f, fields, collect({ messages: [gov, nameErr, emailErr], marks: [aria(0), aria(1)] }), [], 'empty'))).toEqual([]);
      expect(untied(judgeAttempt(f, fields, collect({ messages: [gov] }), [], 'empty'))).toEqual([]);
    });

    it('look-alikes still fail: one generic "Error" with no field errors; a summary with errors only in colour; an untied error beside a field in error', () => {
      expect(untied(judgeAttempt(f, fields, collect({ messages: [msg('Error', { live: true })] }), [], 'empty')).map((x) => x.target)).toEqual(['Name (text field)']);
      const colour = judgeAttempt(f, fields, collect({ messages: [summary], marks: [{ ref: 0, aria: false, style: true, cls: false, icon: false }, { ref: 1, aria: false, style: true, cls: false, icon: false }] }), [], 'empty');
      expect(untied(colour).length).toBeGreaterThan(0);
      expect(untied(colour).map((x) => x.detail).join(' ')).toMatch(/not tied to its field/);
      // The email field is in error and its message, right after it, is not tied to it: still failed.
      const beside = judgeAttempt(f, fields, collect({ messages: [nameErr, msg('This field is required.', { near: 1 })], marks: [aria(0), aria(1)] }), [], 'empty');
      expect(untied(beside).map((x) => x.target)).toEqual(['Email (email field)']);
    });
  });

  it('4.1.3: messages nobody announces fail; a live region, an alert, focus on a message or field, or an announcement do not', () => {
    const msg = { text: 'Enter your name', kind: 'added' as const, near: 0, assoc: [0], names: [], live: false, focus: false };
    expect(judgeAttempt(f, fields, collect({ messages: [msg] }), [], 'empty').findings.map((x) => x.criterion)).toEqual(['4.1.3']);
    for (const over of [{ messages: [{ ...msg, live: true }] }, { messages: [{ ...msg, focus: true }] }, { messages: [msg], focusMoved: true }, { messages: [msg], announcements: ['Enter your name'] }]) {
      expect(judgeAttempt(f, fields, collect(over), [], 'empty').findings).toEqual([]);
    }
  });

  it('3.3.3: after a wrong format, a message that only says "invalid" fails', () => {
    const msg = (text: string) => ({ text, kind: 'text' as const, near: 1, assoc: [1], names: [], live: true, focus: false });
    expect(judgeAttempt(f, fields, collect({ messages: [msg('Invalid')] }), [], 'format', new Set([1])).findings.map((x) => x.criterion)).toEqual(['3.3.3']);
    expect(judgeAttempt(f, fields, collect({ messages: [msg('Enter an email address like name@example.com')] }), [], 'format', new Set([1])).findings).toEqual([]);
    expect(judgeAttempt(f, fields, collect({ messages: [msg('Invalid')] }), [], 'empty').findings).toEqual([]);
    for (const t of ['Invalid', 'Error', 'Wrong format', 'Valor no válido', 'invalid input!']) expect(isGenericError(t)).toBe(true);
    for (const t of ['Enter a date like 31/01/2025', 'Name is required', 'Email must contain @']) expect(isGenericError(t)).toBe(false);
  });
});

describe('judgeOnInput (3.2.2)', () => {
  const f = field({ ref: 0, type: 'select', label: 'Department' });
  it('a navigation, a submit, a new window, an address change or focus leaving the form fails', () => {
    const fails = (obs: Partial<ObserveResult>, guard: GuardEvent[] = []) => judgeOnInput(f, form(), observe(obs), guard, 'https://e.org/', 'Choosing "About"');
    expect(fails({}, [ev({ kind: 'navigation', url: 'https://e.org/about' })])).toMatchObject({ criterion: '3.2.2', status: 'failed', detail: expect.stringContaining('started loading another page') });
    expect(fails({ protoSubmits: [0] })).toMatchObject({ detail: expect.stringContaining('submitted the form') });
    expect(fails({ opens: 1 })).toMatchObject({ detail: expect.stringContaining('opened a new window') });
    expect(fails({}, [ev({ kind: 'url-change', url: 'https://e.org/other' })])).toMatchObject({ detail: expect.stringContaining('changed the page address') });
    expect(fails({ active: { to: 'other', ref: -1, form: -1, label: 'Search' } })).toMatchObject({ detail: expect.stringContaining('moved the focus out of the form') });
    expect(fails({}, [ev({ kind: 'url-change', url: 'https://e.org/#results' })])).toBeNull();
    expect(fails({ submits: [{ form: 0, prevented: true }] })).toBeNull();
    expect(fails({}, [ev({ kind: 'dialog' })])).toBe('dialog');
    // A reload of the page itself (held by the strict guard) is a change of context too.
    expect(fails({}, [ev({ kind: 'navigation', url: 'https://e.org/#top' })])).toMatchObject({ detail: expect.stringContaining('started to reload the page') });
  });
});

describe('static checks', () => {
  it('1.3.5: a field that names a purpose needs a matching autocomplete; ambiguous ones go to the AI', () => {
    const page = {
      forms: [form({ fields: [0, 1, 2, 3] })],
      fields: [
        field({ ref: 0, label: 'Email', type: 'email' }), field({ ref: 1, label: 'Phone', type: 'tel', autocomplete: 'tel' }),
        field({ ref: 2, label: 'Parent email', type: 'email' }), field({ ref: 3, label: 'Postal code', autocomplete: 'off' }),
      ],
    };
    const r = purposeFindings(page);
    expect(r.findings.map((f) => [f.target, f.detail.slice(0, 60)])).toEqual([
      ['Email (email field)', 'the field asks for the person’s email address but has no aut'],
      ['Postal code (text field)', 'the field asks for the postal code but autocomplete="off" hi'],
    ]);
    expect([...r.review]).toEqual([2]);
    expect(r.matched).toBe(3);
  });

  it('3.3.2: placeholder-only and invisible labels fail; visible labels and nearby text do not; a field its Search button labels is skipped', () => {
    const page = {
      forms: [form({ fields: [0, 1, 2, 3, 4] }), form({ index: 1, search: true, fields: [5, 6] })],
      fields: [
        field({ ref: 0, visibleLabel: false, label: '', placeholder: 'Full name' }),
        field({ ref: 1, visibleLabel: false, label: 'Email', type: 'email' }),
        field({ ref: 2, visibleLabel: false, label: 'Room', nearby: 'Room' }),
        field({ ref: 3, type: 'checkbox', visibleLabel: false, label: 'Small', legend: 'Size' }),
        field({ ref: 4, visibleLabel: true }),
        field({ ref: 5, form: 1, visibleLabel: false, label: '', placeholder: 'Search', search: true }),
        // Grok round 2: a search form's other field is judged; the form's search flag skips nothing on its own.
        field({ ref: 6, form: 1, visibleLabel: false, label: '', placeholder: 'Email', type: 'email' }),
      ],
    };
    const r = labelFindings(page);
    expect(r.findings.map((f) => f.target)).toEqual(['Full name (text field)', 'Email (email field)', 'Email (email field)']);
    expect(r.checked).toBe(6);
  });

  it('3.3.2: a required field nothing visible marks fails, unless all fields are said to be required, it is a log-in or a one-field form', () => {
    const fields = [field({ ref: 0, required: true }), field({ ref: 1, label: 'Email', type: 'email', required: true, requiredMark: true })];
    expect(labelFindings({ forms: [form({ fields: [0, 1] })], fields }).findings.map((f) => f.target)).toEqual(['Name (text field)']);
    expect(labelFindings({ forms: [form({ fields: [0, 1], allRequired: true })], fields }).findings).toEqual([]);
    expect(labelFindings({ forms: [form({ fields: [0] })], fields: [fields[0]!] }).findings).toEqual([]);
    const login = [field({ ref: 0, label: 'User name', required: true }), field({ ref: 1, label: 'Password', type: 'password', required: true })];
    expect(labelFindings({ forms: [form({ fields: [0, 1] })], fields: login }).findings).toEqual([]);
  });

  // Real-site audit 2026-11-07: 19 of the test's 3.3.2 failures were FALSE.
  it('3.3.2: does not judge fields out of sight when tested (boise contact panel, a date picker pop-up)', () => {
    const fields = [field({ ref: 0, visibleLabel: false, label: 'First Name', seen: false }), field({ ref: 1, tag: 'select', type: 'select', visibleLabel: false, label: 'Change the month', seen: false })];
    expect(labelFindings({ forms: [form({ fields: [0, 1] })], fields }).findings).toEqual([]);
  });

  it('3.3.2: a select is labelled by a prompt it shows or by being a language picker (Google Translate, GTranslate)', () => {
    const sel = (over: Partial<ScannedField>) => field({ tag: 'select', type: 'select', visibleLabel: false, label: 'Language Translate Widget', ...over });
    expect(labelFindings({ forms: [form()], fields: [sel({ selfLabelled: true })] }).findings).toEqual([]);
    expect(labelFindings({ forms: [form()], fields: [sel({ selfLabelled: false })] }).findings).toHaveLength(1);
  });

  it('3.3.2: a required field that already holds a value needs no mark (ltd-transit prefilled date and time)', () => {
    const fields = [field({ ref: 0, label: 'From', requiredMark: true, required: true }), field({ ref: 1, label: 'Date', type: 'date', required: true, filled: true }), field({ ref: 2, label: 'Time', type: 'time', required: true, filled: true })];
    expect(labelFindings({ forms: [form({ fields: [0, 1, 2] })], fields }).findings).toEqual([]);
    expect(labelFindings({ forms: [form({ fields: [0, 1, 2] })], fields: fields.map((f) => ({ ...f, filled: false })) }).findings).toHaveLength(2);
  });

  // 2026-11-09 benchmark review: WCAG 2.2's input purposes include username; an empty attribute names no purpose
  // (it still fails), and the finding says it is empty rather than missing.
  it('1.3.5: a first-name token on a last-name field (and the reverse) names the wrong purpose (F107)', () => {
    const fields = [
      field({ ref: 0, label: 'Your family name', autocomplete: 'given-name' }), field({ ref: 1, label: 'First name', autocomplete: 'family-name' }),
      // Look-alikes: the matching tokens, a whole-name token on a part of the name, and a part's token on a whole-name field.
      field({ ref: 2, label: 'Last name', autocomplete: 'family-name' }), field({ ref: 3, label: 'First name', autocomplete: 'given-name' }),
      field({ ref: 4, label: 'Last name', autocomplete: 'name' }), field({ ref: 5, label: 'Full name', autocomplete: 'given-name' }),
    ];
    const r = purposeFindings({ forms: [form({ fields: [0, 1, 2, 3, 4, 5] })], fields });
    expect(r.findings.map((f) => [f.target, f.detail])).toEqual([
      ['Your family name (text field)', 'the field asks for the person’s last name but autocomplete="given-name" names another purpose; use autocomplete="family-name"'],
      ['First name (text field)', 'the field asks for the person’s first name but autocomplete="family-name" names another purpose; use autocomplete="given-name"'],
    ]);
  });

  it('1.3.5: a user name field with an empty autocomplete attribute fails, worded as empty', () => {
    const fields = [field({ ref: 0, label: 'Username', autocomplete: '' }), field({ ref: 1, label: 'Username', autocomplete: ' ' }), field({ ref: 2, label: 'Username', autocomplete: null })];
    expect(purposeFindings({ forms: [form({ fields: [0, 1, 2] })], fields }).findings.map((f) => f.detail)).toEqual([
      'the field asks for the person’s user name but has an empty autocomplete attribute; add autocomplete="username"',
      'the field asks for the person’s user name but has an empty autocomplete attribute; add autocomplete="username"',
      'the field asks for the person’s user name but has no autocomplete attribute; add autocomplete="username"',
    ]);
  });

  it('1.3.5: an aria-hidden decoy field (an anti-spam trap, manzanita) and an aria-disabled one are not judged', () => {
    const fields = [field({ ref: 0, label: 'Address', hiddenFromAll: true, shown: false }), field({ ref: 1, label: 'Email', type: 'email', disabled: true })];
    expect(purposeFindings({ forms: [form({ fields: [0, 1] })], fields }).findings).toEqual([]);
    expect(purposeFindings({ forms: [form({ fields: [0] })], fields: [{ ...fields[0]!, hiddenFromAll: false }] }).findings).toHaveLength(1);
  });

  it('1.3.5: autocomplete follows the HTML autofill grammar (ACT 73f2c2)', () => {
    expect(parseAutocomplete('section-a shipping work email')).toMatchObject({ token: 'email', invalid: false });
    expect(parseAutocomplete('billing tel webauthn')).toMatchObject({ token: 'tel', invalid: false });
    expect(parseAutocomplete('work shipping email').invalid).toBe(true);
    expect(parseAutocomplete('work given-name').invalid).toBe(true);
    expect(parseAutocomplete('shipping off').invalid).toBe(true);
    expect(parseAutocomplete('off')).toMatchObject({ none: true });
    expect(parseAutocomplete(' ')).toMatchObject({ none: true });
  });

  it('3.3.4: a card form that pays on one press fails; a confirmation box, a next step or a refund note does not', () => {
    const card = [field({ ref: 0, label: 'Card number', autocomplete: 'cc-number' }), field({ ref: 1, type: 'checkbox', label: 'I confirm the amount is correct' })];
    const pay = form({ fields: [0], submitter: { ref: 0, label: 'Pay now', kind: 'submit' } });
    expect(preventionFindings({ forms: [pay], fields: card.slice(0, 1) })).toMatchObject({ candidates: 1, findings: [{ criterion: '3.3.4', status: 'failed' }] });
    expect(preventionFindings({ forms: [{ ...pay, fields: [0, 1] }], fields: card }).findings).toEqual([]);
    expect(preventionFindings({ forms: [{ ...pay, text: 'You can cancel for a full refund within 14 days.' }], fields: card.slice(0, 1) }).findings).toEqual([]);
    expect(preventionFindings({ forms: [form({ search: true })], fields: [field()] })).toEqual({ findings: [], candidates: 0 });
  });

  it('3.3.8: blocked paste on a log-in fails (not on a sign-up); a copy CAPTCHA fails unless another way to sign in is offered', () => {
    const login = [field({ ref: 0, label: 'User name' }), field({ ref: 1, label: 'Password', type: 'password' })];
    const f = form({ fields: [0, 1] });
    expect(authFindings({ forms: [f], fields: login, altLogin: [] }, new Map([[1, { blocked: true, via: 'paste' }]])).findings)
      .toEqual([expect.objectContaining({ criterion: '3.3.8', status: 'failed', target: 'Password (password field)' })]);
    const signup = [...login, field({ ref: 2, label: 'Confirm password', type: 'password' })];
    expect(authFindings({ forms: [form({ fields: [0, 1, 2] })], fields: signup, altLogin: [] }, new Map([[1, { blocked: true, via: 'paste' }]])).findings.map((x) => x.status))
      .toEqual(['no_failures_found']);
    const captcha = form({ fields: [0, 1], captcha: [{ kind: 'text', provider: '', detail: 'an image of characters to copy' }] });
    expect(authFindings({ forms: [captcha], fields: login, altLogin: [] }, new Map()).findings.map((x) => x.status)).toEqual(['failed']);
    expect(authFindings({ forms: [captcha], fields: login, altLogin: ['Email me a sign-in link'] }, new Map()).findings.map((x) => x.status)).toEqual(['no_failures_found']);
    const widget = form({ fields: [0, 1], captcha: [{ kind: 'widget', provider: 'reCAPTCHA', detail: 'reCAPTCHA' }] });
    expect(authFindings({ forms: [widget], fields: login, altLogin: [] }, new Map()).findings.map((x) => x.status)).toEqual(['no_failures_found']);
    expect(authFindings({ forms: [form()], fields: [field()], altLogin: [] }, new Map())).toEqual({ findings: [], auth: 0 });
  });

  // Review round 1, ruling 9: the earlier answer anywhere on the same page counts (Understanding 3.3.7: "it could be
  // elsewhere on a page, including within a show/hide component"). `where` says where each earlier answer is now.
  const where = (o: Record<number, 'shown' | 'disclosure' | 'maybe' | 'none' | 'unknown'>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));

  it('3.3.7: a later step asking again fails only when the earlier answer is nowhere on the page', () => {
    const email = field({ ref: 0, label: 'Email', type: 'email', autocomplete: 'email' });
    // A field whose own label says it is asked again: the same information.
    const again = field({ ref: 1, label: 'Email again', name: 'email-2', type: 'email', autocomplete: 'email' });
    const earlier = [{ field: email, value: 'test@example.invalid' }];
    const f = redundantFindings(earlier, [{ field: again, value: '' }], '', 2, where({ 0: 'none' }));
    expect(f.map((x) => [x.status, x.target])).toEqual([['failed', 'Email again (email field)']]);
    expect(f[0]!.detail).toContain('nowhere on the page');
    // Batch 18 (D6, ruling Q1): the same person's email, under the same or another label, with nothing in the field,
    // its group or the step's own text (now read: `stepText`) naming another party, is the same information.
    const same = field({ ref: 8, label: 'Email', name: 'email-3', type: 'email', autocomplete: 'email' });
    expect(redundantFindings(earlier, [{ field: same, value: '' }], '', 2, where({ 0: 'none' })).map((x) => x.status)).toEqual(['failed']);
    const contact = field({ ref: 9, label: 'Contact email', type: 'email', autocomplete: 'email' });
    expect(redundantFindings(earlier, [{ field: contact, value: '' }], '', 2, where({ 0: 'none' })).map((x) => x.status)).toEqual(['failed']);
    // A step headed for someone else ("Co-applicant") is other information: no failure.
    expect(redundantFindings(earlier, [{ field: same, value: '' }], '', 2, where({ 0: 'none' }), 'Co-applicant').some((x) => x.status === 'failed')).toBe(false);
    // Filled in, or offered with a "same as" box: not asked again.
    expect(redundantFindings(earlier, [{ field: again, value: 'test@example.invalid' }], '', 2, where({ 0: 'none' }))).toEqual([]);
    expect(redundantFindings(earlier, [{ field: again, value: '' }], 'Same as above', 2, where({ 0: 'none' }))).toEqual([]);
    // Still on the page: shown, or inside something a control on the page shows (a closed "Review your answers").
    expect(redundantFindings(earlier, [{ field: again, value: '' }], '', 2, where({ 0: 'shown' }))).toEqual([]);
    expect(redundantFindings(earlier, [{ field: again, value: '' }], '', 2, where({ 0: 'disclosure' }))).toEqual([]);
    // Hidden with a control that may bring it back (Back, Edit), a value too short to look for, and a page the test
    // did not look at: undecided, never failed.
    for (const w of [where({ 0: 'maybe' }), where({ 0: 'unknown' }), undefined]) {
      expect(redundantFindings(earlier, [{ field: again, value: '' }], '', 2, w).map((x) => x.status)).toEqual(['not_testable']);
    }
  });

  it('3.3.7: the same label in a later step is a candidate, not proof: another person\'s "First name" is no repeat', () => {
    const first = field({ ref: 0, label: 'First name', name: 'first', type: 'text' });
    const earlier = [{ field: first, value: 'Test' }];
    // In a group the page names differently ("Second applicant"): other information, no finding.
    const co = field({ ref: 1, label: 'First name', name: 'co-first', type: 'text', legend: 'Second applicant' });
    expect(redundantFindings(earlier, [{ field: co, value: '' }], '', 2, where({ 0: 'none' }))).toEqual([]);
    // No group on either, nothing declared: batch 18 (D6) reads the step's own text; a step that names nobody else
    // asks the same person again (fails), one that names another person is other information.
    const plain = field({ ref: 2, label: 'First name', name: 'first-b', type: 'text' });
    expect(redundantFindings(earlier, [{ field: plain, value: '' }], '', 2, where({ 0: 'none' })).map((x) => x.status)).toEqual(['failed']);
    expect(redundantFindings(earlier, [{ field: plain, value: '' }], '', 2, where({ 0: 'none' }), 'Your child').some((x) => x.status === 'failed')).toBe(false);
    // Declared for different scopes: the page says they differ.
    const ship = field({ ref: 3, label: 'Postal code', name: 'zip-a', type: 'text', autocomplete: 'shipping postal-code' });
    const bill = field({ ref: 4, label: 'Postal code', name: 'zip-b', type: 'text', autocomplete: 'billing postal-code' });
    expect(redundantFindings([{ field: ship, value: '97301' }], [{ field: bill, value: '' }], '', 2, where({ 3: 'none' }))).toEqual([]);
    // Both fields declare the same purpose in full, under the same label: still a candidate only.
    const again = field({ ref: 5, label: 'Postal code', name: 'zip-c', type: 'text', autocomplete: 'shipping postal-code' });
    expect(redundantFindings([{ field: ship, value: '97301' }], [{ field: again, value: '' }], '', 2, where({ 3: 'none' })).map((x) => x.status)).toEqual(['not_testable']);
    // Look-alike that still fails: the later field says it is asked again.
    const reenter = field({ ref: 15, label: 'Re-enter postal code', name: 'zip-d', type: 'text' });
    expect(redundantFindings([{ field: ship, value: '97301' }], [{ field: reenter, value: '' }], '', 2, where({ 3: 'none' })).map((x) => x.status)).toEqual(['failed']);
    // The same declared purpose in a group with another name ("Emergency contact"), or under another label: the
    // declaration may be careless and the information another person's. Undecided, never failed.
    const own = field({ ref: 9, label: 'Email', name: 'email', type: 'email', autocomplete: 'email', legend: 'Applicant' });
    const other = field({ ref: 10, label: 'Email', name: 'ec-email', type: 'email', autocomplete: 'email', legend: 'Emergency contact' });
    expect(redundantFindings([{ field: own, value: 'test@example.invalid' }], [{ field: other, value: '' }], '', 2, where({ 9: 'none' })).map((x) => x.status)).toEqual(['not_testable']);
    const relabelled = field({ ref: 11, label: 'Emergency contact email', name: 'ec-email', type: 'email', autocomplete: 'email', legend: 'Applicant' });
    expect(redundantFindings([{ field: own, value: 'test@example.invalid' }], [{ field: relabelled, value: '' }], '', 2, where({ 9: 'none' })).map((x) => x.status)).toEqual(['not_testable']);
    // "Confirm email" beside another e-mail field of its own step ("Co-applicant email") confirms that one.
    const coEmail = field({ ref: 12, label: 'Co-applicant email', name: 'co-email', type: 'email' });
    const coConfirm = field({ ref: 13, label: 'Confirm email', name: 'co-email-2', type: 'email' });
    expect(redundantFindings([{ field: field({ ref: 14, label: 'Email', name: 'email', type: 'email' }), value: 'test@example.invalid' }], [{ field: coEmail, value: '' }, { field: coConfirm, value: '' }], '', 2, where({ 14: 'none' })).filter((x) => x.status === 'failed')).toEqual([]);
    // "Confirm email" beside an "Email" field of its own step confirms that one.
    const email = field({ ref: 6, label: 'Email', name: 'email', type: 'email' });
    const email2 = field({ ref: 7, label: 'Email', name: 'co-email', type: 'email', legend: 'Second applicant' });
    const confirm2 = field({ ref: 8, label: 'Confirm email', name: 'co-email-2', type: 'email', legend: 'Second applicant' });
    expect(redundantFindings([{ field: email, value: 'test@example.invalid' }], [{ field: email2, value: '' }, { field: confirm2, value: '' }], '', 2, where({ 6: 'none' }))).toEqual([]);
  });

  it('3.3.7: "again" and "confirm" fields follow the same rule; a password asked twice is security, and an unrelated "again" is no repeat', () => {
    const email = field({ ref: 0, label: 'Contact email', name: 'contact', type: 'email', autocomplete: 'email' });
    const again = field({ ref: 1, label: 'Contact email again', name: 'contact-repeat', type: 'email', autocomplete: 'off' });
    const earlier = [{ field: email, value: 'test@example.invalid' }];
    const f = redundantFindings(earlier, [{ field: again, value: '' }], '', 2, where({ 0: 'none' }));
    expect(f.map((x) => [x.criterion, x.status, x.target])).toEqual([['3.3.7', 'failed', 'Contact email again (email field)']]);
    expect(f[0]!.detail).toContain('step 2 asks again for "Contact email"');
    const confirm = field({ ref: 2, label: 'Confirm contact email', name: 'contact-confirm', type: 'email', autocomplete: 'off' });
    expect(redundantFindings(earlier, [{ field: confirm, value: '' }], '', 2, where({ 0: 'none' })).map((x) => x.status)).toEqual(['failed']);
    expect(redundantFindings(earlier, [{ field: confirm, value: '' }], '', 2, where({ 0: 'disclosure' }))).toEqual([]);
    expect(redundantFindings(earlier, [{ field: confirm, value: '' }], '', 2, where({ 0: 'shown' }))).toEqual([]);
    expect(redundantFindings(earlier, [{ field: again, value: 'test@example.invalid' }], '', 2, where({ 0: 'none' }))).toEqual([]);
    const pw = field({ ref: 3, label: 'Password', type: 'password', name: 'pw' });
    expect(redundantFindings([{ field: pw, value: 'x' }], [{ field: field({ ref: 4, label: 'Password again', type: 'password', name: 'pw2' }), value: '' }], '', 2, where({ 3: 'none' }))).toEqual([]);
    expect(redundantFindings(earlier, [{ field: field({ ref: 5, label: 'Visit again on', name: 'return-date', type: 'text' }), value: '' }], '', 2, where({ 0: 'none' }))).toEqual([]);
  });
});

describe('safety of what the probe types and presses', () => {
  it('test values are clearly fake and carry a mark, so any leak is recognisable', () => {
    const values = [
      syntheticValue(field({ type: 'email' })), syntheticValue(field({ type: 'tel' })), syntheticValue(field({ label: 'Name' }), 'name'),
      syntheticValue(field({ autocomplete: 'street-address' })), syntheticValue(field({ type: 'url' })), syntheticValue(field({ type: 'textarea' })),
      syntheticValue(field({})),
    ];
    expect(values).toEqual([
      'grntedtest@example.invalid', '555-0100', 'Grntedtest Name', '1 Grntedtest Street', 'https://grntedtest.example.invalid', 'Grntedtest message', 'Grntedtest',
    ]);
    expect(values.filter((v) => v !== '555-0100').every((v) => v.toLowerCase().includes(TEST_MARK))).toBe(true);
    expect(values.join(' ')).not.toMatch(/\d{12,}|password/i);
    expect(invalidValue(field({ type: 'email' }))).toBe(TEST_MARK);
    expect(invalidValue(field({ label: 'Message', type: 'textarea' }))).toBeUndefined();
    expect(PASTE_TEXT.password).toContain(TEST_MARK);
  });

  it('never types into passwords, one-time codes, card details or PINs, whatever their label style', () => {
    for (const f of [
      { type: 'password' }, { autocomplete: 'one-time-code' }, { autocomplete: 'cc-number' }, { autocomplete: 'billing cc-csc' },
      { label: 'One-time code' }, { label: 'Verification code' }, { name: 'otp_code' }, { id: 'oneTimeCode' }, { label: 'Card number' },
      { name: 'card_no' }, { name: 'cardno' }, { name: 'pan' }, { name: 'cc_num' }, { name: 'ccnum' }, { label: 'CVV' }, { placeholder: 'CVC' },
      { label: 'Security code' }, { label: 'Expiry date' }, { name: 'expiration-month' }, { label: 'PIN' }, { name: 'the_pin' },
      { label: 'Name on card' }, { label: 'Cardholder' }, { label: 'Card holder name' }, { name: 'card_holder' }, { label: 'CID' }, { name: 'amex-cid' },
      { label: 'Confirmation code' }, { label: 'SMS code' }, { name: 'sms_code' }, { label: 'Security PIN' },
    ]) {
      expect([f, isSensitiveField(field({ label: '', ...f }))]).toEqual([f, true]);
    }
    for (const f of [{ label: 'Full name' }, { label: 'Email', type: 'email' }, { label: 'Spinach order' }, { label: 'Company' }, { name: 'panel_note' }, { name: 'cidade' }, { label: 'Holder of the event' }]) {
      expect([f, isSensitiveField(field(f))]).toEqual([f, false]);
    }
  });

  it('never presses a button that pays, deletes or cancels, never submits a card form or into a frame', () => {
    const fx = { payment: false };
    expect(validationSkip(form({ submitter: { ref: 0, label: 'Delete my account', kind: 'submit' } }), fx)).toMatch(/deletes or cancels/);
    expect(validationSkip(form({ submitter: { ref: 0, label: 'Unsubscribe', kind: 'submit' } }), fx)).toMatch(/deletes or cancels/);
    expect(validationSkip(form({ submitter: { ref: 0, label: 'Donate $25', kind: 'submit' } }), fx)).toMatch(/looks like it pays/);
    expect(validationSkip(form(), { payment: true })).toBe('the form takes card details, so it was not submitted');
    expect(validationSkip(form({ target: 'results-frame' }), fx)).toMatch(/into a frame/);
    expect(validationSkip(form({ kind: 'role', submitter: null }), fx)).toMatch(/no button/);
    expect(validationSkip(form(), fx)).toBeUndefined();
  });

  it('evidence is trimmed to fit the run\'s data cap rather than dropped whole', () => {
    const forms = Array.from({ length: 25 }, (_, i) => ({ key: `0:${i}`, text: 'x'.repeat(800), fields: Array.from({ length: 30 }, (_, r) => ({ ref: r, label: 'y'.repeat(120) })) }));
    const fit = fitEvidence(forms);
    expect(JSON.stringify({ version: 1, forms: fit }).length).toBeLessThanOrEqual(PROBE_DATA_MAX_CHARS);
    expect(fit.length).toBeGreaterThan(3);
    expect(fit.map((f) => f.key)).toEqual(forms.slice(0, fit.length).map((f) => f.key));
    expect(fit.every((f) => f.fields.length === 15)).toBe(true);
    const small = [{ key: '0:0', fields: [{ ref: 0 }] }];
    expect(fitEvidence(small)).toBe(small);
  });

  it('formSig names the fields, never their values', () => {
    const fields = new Map([[0, field({ name: 'Email', type: 'email' })], [1, field({ ref: 1, id: 'msg', type: 'textarea' })]]);
    expect(formSig(form({ fields: [0, 1] }), fields)).toBe('email:email|textarea:msg');
  });
});

describe('batch 17 (2026-11-12): self-updating live data is never the form\'s answer', () => {
  const msg = (text: string, o: object = {}) => ({ text, kind: 'text' as const, near: -1, assoc: [] as number[], names: [] as number[], live: false, focus: false, ...o });
  const walk = field({ ref: 0, type: 'select', label: 'Maximum walking distance' });
  const fields = new Map([[0, walk]]);
  const f = form({ name: 'Path preferences', fields: [0], noValidate: true, submitter: { ref: 0, label: 'Update trip options', kind: 'submit' } });
  const failed = (r: { findings: { criterion: string; status: string }[] }) => r.findings.filter((x) => x.status === 'failed').map((x) => x.criterion);

  it('RED: an arrival time that changed beside the form while the submit was watched is not a message of the form', () => {
    // Before: "the form showed 1 error message (for example "7 min") that screen readers do not announce" (4.1.3 failed).
    const r = judgeAttempt(f, fields, collect({ messages: [msg('7 min')] }), [], 'empty');
    expect(r.findings).toEqual([]);
    expect(r.outcome).toBe('silent');
    expect(r.reason).toBe('submitting the form showed no message of its own and sent nothing; what changed on the page meanwhile ("7 min") is outside the form, is not an error by its words and was not written by the submit, so it is not the form\'s answer, and the form\'s error handling could not be observed');
    expect(r.seen.messages).toBe(0);
  });

  it('RED: what a timer the page had running wrote is never the answer, in the form, by a field or tied to one', () => {
    for (const where of [{ inForm: true as const, near: 0 }, { inForm: true as const, near: 0, assoc: [0] }, { near: -1 }, { near: -1, direct: true as const }]) {
      const r = judgeAttempt(f, fields, collect({ messages: [msg('Next bus in 7 min', { ...where, timer: true })] }), [], 'empty');
      expect(r.findings, JSON.stringify(where)).toEqual([]);
      expect(r.outcome).toBe('silent');
      expect(r.reason).toMatch(/\("Next bus in 7 min"\) is written by a timer the page runs by itself/);
    }
    // With an error state too (a field found invalid): the live value is no untied error message (3.3.1).
    const r = judgeAttempt(f, fields, collect({ messages: [msg('Next bus in 7 min', { inForm: true, near: 0, timer: true })], invalid: [{ ref: 0, message: 'Please select an item.', prevented: true }] }), [], 'empty');
    expect(r.findings.some((x) => /7 min/.test(x.detail))).toBe(false);
    expect(r.errors.some((e) => /7 min/.test(e.text))).toBe(false);
    // The filled-in attempt: a live value in the form is no status message of the form.
    expect(judgeValid(f, collect({ messages: [msg('Next bus in 7 min', { inForm: true, near: 0, timer: true })] }), [])).toMatchObject({ outcome: 'silent', findings: [] });
    // And no "names no field" error (3.3.1), whatever its words.
    const two = new Map([[0, walk], [1, field({ ref: 1, label: 'Stop name' })]]);
    const g = form({ fields: [0, 1], noValidate: true });
    expect(unidentifiedError(g, two, collect({ messages: [msg('Service cannot run on Elm Street today', { inForm: true, near: 0, timer: true })] }), [], 'empty')).toBeNull();
  });

  it('look-alikes: the form\'s own unannounced answers still fail 4.1.3', () => {
    // In the form, by a field.
    expect(failed(judgeAttempt(f, fields, collect({ messages: [msg('Choose a distance you can manage', { inForm: true, near: 0 })] }), [], 'empty'))).toContain('4.1.3');
    // Elsewhere, written while the submit's own events ran (a toast).
    expect(failed(judgeAttempt(f, fields, collect({ messages: [msg('Your options were kept as they are', { direct: true })] }), [], 'empty'))).toEqual(['4.1.3']);
    // Elsewhere, an error by its words (a summary above the form), written a moment later.
    expect(failed(judgeAttempt(f, fields, collect({ messages: [msg('There is a problem: choose a walking distance.')] }), [], 'empty'))).toEqual(['4.1.3']);
    // Tied to a field (described-by), wherever it is.
    expect(failed(judgeAttempt(f, fields, collect({ messages: [msg('Pick one of the two distances', { assoc: [0] })] }), [], 'empty'))).toEqual(['4.1.3']);
    // The live value beside a real answer changes nothing about the answer, and is not counted with it.
    const both = judgeAttempt(f, fields, collect({ messages: [msg('7 min'), msg('Choose a distance you can manage', { inForm: true, near: 0 })] }), [], 'empty');
    expect(both.findings.find((x) => x.criterion === '4.1.3')!.detail).toMatch(/^the form showed 1 error message \(for example "Choose a distance you can manage"\)/);
    expect(both.seen.messages).toBe(1);
  });

  it('attemptAnswer: announced or focused text, and anything of the form, is its answer; live data never', () => {
    expect(attemptAnswer(msg('7 min'))).toBe(false);
    expect(attemptAnswer(msg('Route 24 follows in 11 minutes.'))).toBe(false);
    expect(attemptAnswer(msg('7 min', { live: true }))).toBe(true);
    expect(attemptAnswer(msg('Saved', { focus: true }))).toBe(true);
    expect(attemptAnswer(msg('Saved', { names: [0] }))).toBe(true);
    expect(attemptAnswer(msg('Saved', { links: [0] }))).toBe(true);
    expect(attemptAnswer(msg('Enter a stop name'))).toBe(true);
    expect(attemptAnswer(msg('Enter a stop name', { timer: true }))).toBe(false);
    expect(attemptAnswer(msg('7 min', { live: true, timer: true }))).toBe(false);
  });
});
