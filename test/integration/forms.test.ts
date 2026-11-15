// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The form probes (Plan 4 Task 4.6) in real Chromium on synthetic fixtures (test/fixtures/forms/):
// planted failures and clean controls for every criterion, the failure modes (forms that act on
// input, steps, frames, server-only validation, hostile pages, a hung page), and the safety rule:
// nothing typed ever reaches the server.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FORM_FIELDS_PROBE_ID, SERVER_ONLY, formFieldsProbe, formsProbe, type FormsInteractionData, type FormsProbeData } from '../../src/probes/forms.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, CriterionStatus, ProbeFinding, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const requests: { method: string; url: string; headers: Record<string, string | string[] | undefined> }[] = [];
const runsByProbe = new Map<string, Map<string, ProbeRun>>();

const PAGES = [
  'good-validation', 'bad-validation', 'on-input', 'silent-check', 'login-paste', 'login-captcha', 'login-widget', 'steps', 'steps-good',
  'steps-server', 'autocomplete', 'labels', 'labels-good', 'server-only', 'payment', 'payment-good', 'native', 'search', 'none', 'hostile',
  'framed', 'reload', 'login-watch', 'shadow', 'hidden-form', 'leaks', 'otp-label', 'format-send', 'format-replace', 'dialog-change', 'decoys',
  'summary-described', 'summary-govuk', 'summary-colour', 'labels-audit', 'labels-search', 'error-words', 'login-sum-words', 'login-words-clean',
  'self-updating', 'steps-review', 'steps-gone', 'steps-back', 'steps-hidden', 'steps-arrow', 'steps-same', 'steps-links', 'steps-pieces',
];
/** Every value the probes type contains one of these (see `syntheticValue`, `PASTE_TEXT`), so a leak is visible in any request. */
const TOKENS = ['grntedtest', '555-0100', '000000'];
/** Paths and headers the leaks fixture uses to smuggle what was typed. */
const LEAK_PATHS = ['/leak/', '/static/icon-', '/late.gif'];
/** Paths the fixtures send data to. None of them may ever be requested. */
const ACTION_PATHS = [
  '/contact', '/call', '/news', '/brochure', '/login', '/volunteer', '/permit', '/newsletter', '/book', '/feedback', '/fees', '/card', '/quote',
  '/autosave', '/suggest', '/pixel.gif', '/xhr', '/late', '/late-beacon', '/frame-load', '/events', '/framed-contact', '/subscribe-list',
  '/about.html', '/sports.html', '/staff-login', '/shadow-join', '/dialog-contact', '/credential-typed-lw-pw.gif', '/credential-typed-lw-code.gif',
  '/leaky', '/confirm-code', '/callback', '/prefs', '/site-search/', '/trip', '/borrow-quiz', '/borrow-join', '/hold-kit', '/visit-plan', '/save-draft', '/allotment', '/plot', '/shed', '/greenhouse', '/compost', '/seeds', '/tools', '/orchard',
];
/** Fields anything was typed into (fixtures mark them with data-typed), read after the deep probe on the same page. */
const typedFields = new Map<string, string[]>();

const run = (probe: string, page: string): ProbeRun => runsByProbe.get(probe)!.get(page)!;
const of = (r: ProbeRun, criterion: string, status?: CriterionStatus): ProbeFinding[] =>
  r.findings.filter((f) => f.criterion === criterion && (!status || f.status === status));
/** The page's status for a criterion, as the criteria table aggregates it (worst finding). */
const statusOf = (r: ProbeRun, criterion: string): CriterionStatus => {
  const rank: Record<CriterionStatus, number> = { failed: 4, flagged: 3, not_testable: 2, no_failures_found: 1, not_applicable: 0 };
  const found = of(r, criterion);
  return found.length ? found.reduce<CriterionStatus>((w, f) => (rank[f.status] > rank[w] ? f.status : w), 'not_applicable') : 'no_failures_found';
};

beforeAll(async () => {
  server = await startFixtureServer('forms', {}, { onRequest: (req: IncomingMessage) => { requests.push({ method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers } }); } });
  browser = await chromium.launch();
  for (const probe of [formFieldsProbe, formsProbe]) {
    const runs = await runProbes(browser as unknown as BrowserLike, PAGES.map((p, index) => ({ url: `${server.origin}/${p}.html`, index })), [probe],
      { userAgent: 'grnted-test', settleMs: 200, full: true });
    runsByProbe.set(probe.id, new Map(runs.map((r) => [new URL(r.page).pathname.slice(1, -5), r])));
    if (process.env.FORMS_TIMING) {
      for (const r of runs) process.stdout.write(`${probe.id} ${new URL(r.page).pathname} ${r.status} ${r.ms} ms\n`);
    }
  }
  // The deep probe again on the pages that mark typed fields, reading the marks before the page closes.
  const watch: PageProbe = {
    ...formsProbe,
    async run(ctx) {
      const findings = await formsProbe.run(ctx);
      const typed = await ctx.page.evaluate(() => Array.from(document.querySelectorAll('[data-typed]')).map((e) => e.id), undefined);
      typedFields.set(new URL(ctx.url).pathname.slice(1, -5), typed);
      return findings;
    },
  };
  await runProbes(browser as unknown as BrowserLike, ['payment', 'otp-label', 'login-watch'].map((p, index) => ({ url: `${server.origin}/${p}.html`, index })), [watch],
    { userAgent: 'grnted-test', settleMs: 200, full: true });
  // Give any delayed handler (a late autosave) the time to try.
  await new Promise((r) => setTimeout(r, 800));
}, 180_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('safety: nothing typed reaches the server', () => {
  it('every request was a GET or HEAD without a query string, and no action address was ever requested', () => {
    expect(requests.length).toBeGreaterThan(PAGES.length);
    expect(requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD')).toEqual([]);
    expect(requests.filter((r) => r.url.includes('?'))).toEqual([]);
    expect(requests.filter((r) => ACTION_PATHS.some((p) => r.url === p || r.url.startsWith(`${p}?`) || r.url.startsWith(`${p}/`)))).toEqual([]);
  });

  it('no request carries a typed value anywhere: path, query, headers or cookies', () => {
    const text = (r: (typeof requests)[number]) => {
      let url = r.url;
      try { url = decodeURIComponent(r.url); } catch { /* keep */ }
      return `${url} ${JSON.stringify(r.headers)}`.toLowerCase();
    };
    expect(requests.filter((r) => TOKENS.some((t) => text(r).includes(t)))).toEqual([]);
  });

  it('values smuggled in image, stylesheet, CSS and worker paths, page-URL headers, cookies, saved references and late timers never leave', () => {
    expect(requests.filter((r) => LEAK_PATHS.some((p) => r.url.startsWith(p)))).toEqual([]);
    expect(requests.filter((r) => r.headers['x-draft'] !== undefined || r.headers['x-saved-fetch'] !== undefined)).toEqual([]);
    expect(requests.filter((r) => String(r.headers.cookie ?? '').includes('draft='))).toEqual([]);
    // The leaks page was loaded by both probes and nothing else was requested for it.
    expect(requests.filter((r) => r.url === '/leaks.html').length).toBe(2);
  });

  it('never types into card, code or PIN fields, and never types into a form that takes card details', () => {
    expect(typedFields.get('payment')).toEqual([]);
    expect(typedFields.get('otp-label')).toEqual(['ol-note']);
    expect(typedFields.get('login-watch')).toEqual(['lw-user']);
  });

  it('a form that would send its answers is not testable, with the reason', () => {
    expect(of(run('forms', 'server-only'), '3.3.1')).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(SERVER_ONLY) })]);
    expect(of(run('forms', 'hostile'), '3.3.1')).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(SERVER_ONLY) })]);
    // A hostile page that sends on every keystroke is not a change of context (nothing left the page).
    expect(statusOf(run('forms', 'hostile'), '3.2.2')).toBe('no_failures_found');
  });

  it('never types anything but the paste test into a password or code field', () => {
    expect(requests.filter((r) => r.url.startsWith('/credential-typed'))).toEqual([]);
    // The page itself was tested (its email field got a wrong format).
    expect(statusOf(run('forms', 'login-watch'), '3.3.1')).not.toBe('not_applicable');
  });

  it('never presses the button of a form that takes card details', () => {
    expect(of(run('forms', 'payment'), '3.3.1')).toEqual([expect.objectContaining({ status: 'not_testable', detail: 'the form takes card details, so it was not submitted' })]);
  });

  it('a next step that comes from the server is not opened', () => {
    expect(of(run('forms', 'steps-server'), '3.3.7')).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('comes from the live server') })]);
  });
});

describe('form-fields (core)', () => {
  it('1.3.5: fields that ask for personal information without autocomplete fail; fields with it do not', () => {
    const failed = of(run(FORM_FIELDS_PROBE_ID, 'autocomplete'), '1.3.5', 'failed').map((f) => f.target);
    expect(failed).toEqual(['Name * (text field)', 'E-mail address * (email field)', 'Phone number (tel field)', 'Correo electrónico (text field)']);
    for (const p of ['good-validation', 'native', 'labels-good']) expect(statusOf(run(FORM_FIELDS_PROBE_ID, p), '1.3.5')).toBe('no_failures_found');
  });

  it('3.3.2: placeholder-only and invisible labels, and unmarked required fields, fail; visible labels and marks do not', () => {
    const r = run(FORM_FIELDS_PROBE_ID, 'labels');
    expect(of(r, '3.3.2', 'failed').map((f) => [f.target, f.detail.slice(0, 40)])).toEqual([
      ['Full name (text field)', "the field's only label is its placeholde"],
      ['Email (email field)', 'the field has no visible label or instru'],
      ['Full name (text field)', 'the field must be filled in, but nothing'],
      ['Email (email field)', 'the field must be filled in, but nothing'],
      ['Room (drop-down list)', 'the field must be filled in, but nothing'],
      ['Date (date field)', 'the field must be filled in, but nothing'],
    ]);
    for (const p of ['labels-good', 'good-validation', 'native', 'steps', 'login-paste']) expect(statusOf(run(FORM_FIELDS_PROBE_ID, p), '3.3.2')).toBe('no_failures_found');
  });

  it('3.3.2: fields nobody can see or reach (a CAPTCHA response box, an anti-spam trap) are not fields; a legend\'s mark covers its group', () => {
    const r = run(FORM_FIELDS_PROBE_ID, 'decoys');
    // Only the genuinely unlabelled field fails: not the hidden trap fields, not the CAPTCHA response
    // boxes, and not First/Last Name (labelled by visible hints, required mark in the group's legend).
    expect(of(r, '3.3.2', 'failed').map((f) => [f.target, f.detail.slice(0, 40)])).toEqual([
      ['list_email (email field)', 'the field has no visible label or instru'],
    ]);
    const all = r.findings.map((f) => `${f.target ?? ''} ${f.detail}`).join('\n');
    expect(all).not.toMatch(/hidden response|fax_number|website|captcha-response|turnstile/i);
  });

  // Real-site audit 2026-11-07: the false 3.3.2 and 1.3.5 patterns, with one real failure kept.
  it('3.3.2 and 1.3.5 on the audit\'s patterns: only the placeholder-only newsletter field fails 3.3.2', () => {
    const r = run(FORM_FIELDS_PROBE_ID, 'labels-audit');
    // Grok round 1: "Go", an unnamed icon link and a select parked off screen but in the Tab order fail too.
    expect(of(r, '3.3.2', 'failed').map((f) => [f.target, f.detail.slice(0, 40)])).toEqual([
      ['Search books, movies and more. (text field)', "the field's only label is its placeholde"],
      ['Site Search (text field)', "the field's only label is its placeholde"],
      ['Change the month (drop-down list)', 'the field has no visible label or instru'],
      ['Email Address (text field)', "the field's only label is its placeholde"],
      ['Search… (text field)', "the field's only label is its placeholde"],
    ]);
    // A field next to a button named Search (in text, or an icon's name) is labelled by it (G167).
    expect(statusOf(run(FORM_FIELDS_PROBE_ID, 'labels-search'), '3.3.2')).not.toBe('failed');
    // The closed panel's fields still need autocomplete; the trap and the aria-disabled field are not judged.
    expect(of(r, '1.3.5', 'failed').map((f) => f.target)).toEqual(['First Name (text field)', 'Email Address (text field)']);
  });

  it('3.3.4: a card form that pays on one press fails; one with a confirmation box does not', () => {
    expect(of(run(FORM_FIELDS_PROBE_ID, 'payment'), '3.3.4', 'failed')).toHaveLength(1);
    expect(statusOf(run(FORM_FIELDS_PROBE_ID, 'payment-good'), '3.3.4')).toBe('no_failures_found');
    expect(statusOf(run(FORM_FIELDS_PROBE_ID, 'login-paste'), '3.3.4')).toBe('not_applicable');
  });

  it('3.3.8: blocked paste and a copy-the-characters CAPTCHA on a log-in fail; a checkbox CAPTCHA does not', () => {
    expect(of(run(FORM_FIELDS_PROBE_ID, 'login-paste'), '3.3.8', 'failed').map((f) => f.target)).toEqual(['Password (password field)']);
    expect(of(run(FORM_FIELDS_PROBE_ID, 'login-captcha'), '3.3.8', 'failed')).toHaveLength(1);
    expect(statusOf(run(FORM_FIELDS_PROBE_ID, 'login-widget'), '3.3.8')).toBe('no_failures_found');
    // A calculation asked in words ("What is twelve plus six?") is a sum to solve too; number words with no sum are not.
    expect(of(run(FORM_FIELDS_PROBE_ID, 'login-sum-words'), '3.3.8', 'failed').map((f) => f.detail)).toEqual([expect.stringContaining('a sum to solve: "What is twelve plus six"')]);
    expect(of(run(FORM_FIELDS_PROBE_ID, 'login-words-clean'), '3.3.8', 'failed')).toEqual([]);
    expect(statusOf(run(FORM_FIELDS_PROBE_ID, 'good-validation'), '3.3.8')).toBe('not_applicable');
  });

  it('looks into embedded frames', () => {
    const failed = of(run(FORM_FIELDS_PROBE_ID, 'framed'), '3.3.2', 'failed');
    expect(failed).toEqual([expect.objectContaining({ target: expect.stringMatching(/^Your name \(text field\) \(in the embedded frame http:.*\/framed-form\.html\)$/) })]);
  });

  it('fields it cannot reach (inside web components) are not testable, never "not applicable"', () => {
    for (const probe of [FORM_FIELDS_PROBE_ID, 'forms']) {
      const r = run(probe, 'shadow');
      expect(r.findings.length).toBeGreaterThan(0);
      expect(r.findings.every((f) => f.status === 'not_testable' && f.detail === 'the page has 1 form field inside web components (shadow DOM), which the form test does not reach yet')).toBe(true);
    }
  });

  it('pages without forms, and search forms, are not applicable', () => {
    for (const c of ['1.3.5', '3.3.2', '3.3.4', '3.3.8']) {
      expect(statusOf(run(FORM_FIELDS_PROBE_ID, 'none'), c)).toBe('not_applicable');
      expect(statusOf(run(FORM_FIELDS_PROBE_ID, 'search'), c)).toBe('not_applicable');
    }
  });

  it('attaches the forms as evidence for the AI review, without any field value', () => {
    const data = run(FORM_FIELDS_PROBE_ID, 'autocomplete').data as FormsProbeData;
    expect(data.version).toBe(1);
    expect(data.forms).toHaveLength(1);
    expect(data.forms[0]).toMatchObject({ key: '0:0', name: 'Join the newsletter', method: 'post', action: '/newsletter', login: false, buttons: ['Join'] });
    expect(data.forms[0]!.fields.find((f) => f.name === 'guardian')).toMatchObject({ review: true, type: 'email' });
    expect(JSON.stringify(run(FORM_FIELDS_PROBE_ID, 'login-paste').data)).not.toMatch(/Test-paste|value/);
    expect((run(FORM_FIELDS_PROBE_ID, 'search').data as FormsProbeData).forms).toEqual([]);
  });
});

describe('forms (deep)', () => {
  it('3.2.2: a list that navigates and a check box that submits fail; ordinary fields do not', () => {
    const failed = of(run('forms', 'on-input'), '3.2.2', 'failed').map((f) => f.target);
    expect(failed).toEqual(expect.arrayContaining(['Go to a department (drop-down list)', 'Include archived news (checkbox field)']));
    expect(failed).toHaveLength(2);
    // The reload is held by the guard (it would carry cookies set from what was typed) and is the change of context.
    expect(of(run('forms', 'reload'), '3.2.2', 'failed')).toEqual([expect.objectContaining({ detail: expect.stringContaining('reload the page') })]);
    for (const p of ['good-validation', 'bad-validation', 'autocomplete']) expect(statusOf(run('forms', p), '3.2.2')).toBe('no_failures_found');
  });

  it('3.3.1, 3.3.3, 4.1.3: unidentified, generic and unannounced errors fail', () => {
    const r = run('forms', 'bad-validation');
    expect(of(r, '3.3.1', 'failed').map((f) => f.target)).toEqual(['Phone (tel field)', 'Your name (text field)', 'Email (email field)']);
    expect(of(r, '3.3.3', 'failed').map((f) => f.target)).toEqual(['Email (email field)']);
    // Once after the empty submit, once after the wrong formats.
    expect(of(r, '4.1.3', 'failed').map((f) => f.detail.slice(0, 50))).toEqual([
      'the form showed 1 error message (for example "This', 'the form showed 1 error message (for example "Inva',
    ]);
    const silent = of(run('forms', 'silent-check'), '3.3.1', 'failed');
    expect(silent[0]).toMatchObject({ target: 'form "Request a brochure"', detail: expect.stringMatching(/^pressing "Send request" with the required fields empty did nothing visible/) });
    expect(silent.every((f) => f.detail.includes('did nothing visible'))).toBe(true);
  });

  it('clean controls: tied, specific, announced messages and the browser\'s own messages', () => {
    for (const p of ['good-validation', 'native']) {
      for (const c of ['3.3.1', '3.3.3', '4.1.3']) expect([p, c, statusOf(run('forms', p), c)]).toEqual([p, c, 'no_failures_found']);
    }
  });

  it('RED (real scan): an error summary beside the fields\' own tied errors (a page alert; GOV.UK\'s summary of links) is not an untied error', () => {
    for (const p of ['summary-described', 'summary-govuk']) expect([p, statusOf(run('forms', p), '3.3.1'), of(run('forms', p), '3.3.1', 'failed')]).toEqual([p, 'no_failures_found', []]);
  });

  it('RED (real scan): GOV.UK\'s summary takes focus on every submit: announced on the second attempt too (focus is judged from where it was when the form was submitted)', () => {
    // After the empty attempt focus stays on the summary; the wrong-format attempt types into the fields
    // and submits, and the page moves focus to the summary again.
    expect([statusOf(run('forms', 'summary-govuk'), '4.1.3'), of(run('forms', 'summary-govuk'), '4.1.3', 'failed')]).toEqual(['no_failures_found', []]);
  });

  it('a generic summary alert with the fields marked only in colour still fails 3.3.1', () => {
    const failed = of(run('forms', 'summary-colour'), '3.3.1', 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.map((f) => f.detail).join(' ')).toMatch(/not tied to its field|only by a colour change|a change of style/);
  });

  it('unfinished checks are not testable, never "no failures found"', () => {
    // The wrong formats would have been sent to the server: 3.3.3 could not be observed.
    const send = run('forms', 'format-send');
    expect(of(send, '3.3.3')).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(SERVER_ONLY) })]);
    // The page replaced itself after the wrong formats.
    const replaced = run('forms', 'format-replace');
    expect(of(replaced, '3.3.3', 'no_failures_found')).toEqual([]);
    expect(of(replaced, '3.3.3', 'not_testable')).toEqual([expect.objectContaining({ detail: expect.stringContaining('replaced') })]);
    // A dialog when a field changed stops the test: 3.2.2 is not testable, not clean.
    expect(of(run('forms', 'dialog-change'), '3.2.2')).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('dialog') })]);
  });

  it('3.3.1: an error message that repeats its field\'s own words says which field it means; one that does not, and is tied to none, fails', () => {
    expect(of(run('forms', 'error-words'), '3.3.1', 'failed').map((f) => f.target)).toEqual(['Town (text field)']);
  });

  it('text that changes by itself beside a form (a countdown, a blinking notice) is not a message of the form; a steady one is', () => {
    const r = run('forms', 'self-updating');
    expect(r.findings.map((f) => `${f.target ?? ''} ${f.detail}`).join('\n')).not.toMatch(/seconds|Winter hours|Gate B/);
    expect(of(r, '4.1.3', 'failed').map((f) => f.target)).toEqual([expect.stringContaining('Save for later')]);
    expect(of(r, '4.1.3', 'failed')[0]!.detail).toContain('Your note is kept on this device');
  });

  it('3.3.7: an earlier answer that is still on the page, inside a closed "Review earlier answers", is available to select: no failure', () => {
    const r = run('forms', 'steps-review');
    expect(of(r, '3.3.7', 'failed')).toEqual([]);
    expect(statusOf(r, '3.3.7')).toBe('no_failures_found');
  });

  it('3.3.7 (review round 2, finding 1): an earlier answer shown on the page across elements ("name" and "host" in two spans with the @ between) is available to select: no failure', () => {
    const r = run('forms', 'steps-pieces');
    expect(of(r, '3.3.7', 'failed')).toEqual([]);
    expect(statusOf(r, '3.3.7')).toBe('no_failures_found');
  });

  it('3.3.7: asked to confirm it with the first step gone from the page fails; with only a Back button it fails too (batch 18, ruling Q1)', () => {
    expect(of(run('forms', 'steps-gone'), '3.3.7', 'failed').map((f) => f.target)).toEqual(['Confirm email * (email field)']);
    expect(of(run('forms', 'steps-gone'), '3.3.7', 'failed')[0]!.detail).toContain('nowhere on the page');
    // Batch 18 (lead's ruling Q1): going back to the earlier step takes this step away, so it is no way to select
    // the answer at this step; with strong proof (the same person's email) that fails.
    const back = run('forms', 'steps-back');
    expect(of(back, '3.3.7', 'failed').map((f) => f.target)).toEqual(['Email * (email field)']);
  });

  it('3.3.7: an answer reachable only by going back to its step (step buttons, step links, an arrow) is not available at this step (batch 18, ruling Q1)', () => {
    // The first step is hidden, not removed, and numbered step buttons outside the form show it again in place of this
    // step; the same with links to the steps' own places; the first step removed and an arrow beside the send button.
    // Each takes this step away: with strong proof ("Confirm email" asks again), each fails.
    for (const p of ['steps-hidden', 'steps-links', 'steps-arrow']) {
      expect(of(run('forms', p), '3.3.7', 'failed').map((f) => f.target), p).toEqual(['Confirm email * (email field)']);
    }
  });

  it('3.3.7: a later step that asks again fails; one that fills it in does not', () => {
    // Batch 18 (D6, ruling Q1): the same person's email asked again, and nothing in the field, its group or its step
    // names another party (the step's own heading and text are read now): the same information. It fails, in no
    // group, and with each step in a group of its own name ("Step 2: How to reach you"). A group or a step named for
    // another person ("Second applicant") stays clean (test/integration/b18Forms.test.ts).
    expect(of(run('forms', 'steps-same'), '3.3.7', 'failed').map((f) => f.target)).toEqual(['Email * (email field)']);
    expect(of(run('forms', 'steps'), '3.3.7', 'failed').map((f) => f.target)).toEqual(['Email * (email field)']);
    expect(statusOf(run('forms', 'steps-good'), '3.3.7')).toBe('no_failures_found');
    expect(statusOf(run('forms', 'good-validation'), '3.3.7')).toBe('not_applicable');
  });

  it('tests forms inside embedded frames', () => {
    const r = run('forms', 'framed');
    expect(of(r, '3.3.1', 'failed').map((f) => f.detail.slice(0, 30))).toEqual(['the error message "Required" i', 'the error message "Wrong" is n']);
    expect(of(r, '3.3.1', 'failed').every((f) => /^Email \(email field\) \(in the embedded frame http:.*\/framed-form\.html\)$/.test(f.target!))).toBe(true);
    expect(of(r, '3.3.3', 'failed')).toHaveLength(1);
  });

  it('a form that is not shown (a closed dialog) is not testable, not clean', () => {
    const r = run('forms', 'hidden-form');
    for (const c of ['3.2.2', '3.3.1', '3.3.3', '4.1.3']) {
      expect(of(r, c)).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('not shown on the page') })]);
    }
  });

  it('a page without forms: nothing applies, and status messages could not be tested', () => {
    const r = run('forms', 'none');
    for (const c of ['3.2.2', '3.3.1', '3.3.3', '3.3.7']) expect(statusOf(r, c)).toBe('not_applicable');
    expect(statusOf(r, '4.1.3')).toBe('not_testable');
  });

  it('attaches the error messages the page showed, for the AI review', () => {
    const data = run('forms', 'good-validation').data as FormsInteractionData;
    expect(data.forms).toEqual([expect.objectContaining({ key: '0:0', validation: 'client', steps: 1 })]);
    expect(data.forms[0]!.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 1, after: 'wrong_format', text: 'Enter an email address in the format name@example.com', source: 'page' }),
    ]));
    expect((run('forms', 'server-only').data as FormsInteractionData).forms[0]).toMatchObject({ validation: 'server', errors: [] });
  });

  it('a page that hangs on input times out as not testable', async () => {
    const quick: PageProbe = { ...formsProbe, timeoutMs: 4000 };
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/busy.html`, index: 0 }], [quick], { userAgent: 'grnted-test', settleMs: 100, full: true });
    expect(r!.status).toBe('timeout');
    expect(r!.findings.every((f) => f.status === 'not_testable' && /timed out/.test(f.detail))).toBe(true);
  }, 30_000);
});
