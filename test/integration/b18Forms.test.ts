// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, forms lane (docs/atlas/forms.md): the in-page halves of the new decision paths, in real Chromium on
// synthetic fixtures (test/fixtures/b18-forms/). Each failure has a look-alike that must stay clean. The probes run
// with the strict guard as in a scan: nothing reaches the fixture server's form handlers.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formFieldsProbe, formsProbe } from '../../src/probes/forms.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, CriterionStatus, ProbeFinding, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const runs = new Map<string, ProbeRun[]>();

/** Pages per decision path. */
const PAGES = {
  d14: ['status-created-with-text', 'status-aria-hidden', 'alert-inserted', 'status-existing'],
  d15: ['jump-silent', 'jump-advised', 'jump-advised-after'],
  steps: ['step-two-forms', 'step-two-forms-other-words', 'step-two-forms-populated', 'step-two-forms-signature', 'step-two-forms-second-applicant', 'step-two-forms-copy-button', 'step-two-forms-datalist', 'step-rendered', 'step-rendered-shown'],
  more: ['validator-asterisk', 'validator-message', 'pattern-no-title', 'pattern-titled', 'login-username-paste', 'login-username-trim', 'pay-bank', 'pay-bank-confirm', 'dob-parts', 'pothole-address'],
  choices: ['filter-count-quiet', 'filter-count-live', 'choice-reveals-hint'],
  labels: ['req-by-script', 'req-optional-convention', 'req-css-icon', 'label-css-content', 'label-hidden-mobile', 'label-floating', 'label-vanishing', 'heading-two-fields', 'heading-phone-parts', 'g167-subscribe', 'g167-promo'],
};

const of = (page: string, criterion: string, status?: CriterionStatus): ProbeFinding[] =>
  (runs.get(page) ?? []).flatMap((r) => r.findings).filter((f) => f.criterion === criterion && (!status || f.status === status));
const failed = (page: string, criterion: string) => of(page, criterion, 'failed');

beforeAll(async () => {
  server = await startFixtureServer('b18-forms');
  browser = await chromium.launch();
  const pages = Object.values(PAGES).flat();
  const out = await runProbes(browser as unknown as BrowserLike, pages.map((p, index) => ({ url: `${server.origin}/${p}.html`, index })), [formFieldsProbe, formsProbe],
    { userAgent: 'grnted-test', settleMs: 200, full: true });
  for (const r of out) {
    const key = new URL(r.page).pathname.slice(1, -5);
    runs.set(key, [...(runs.get(key) ?? []), r]);
  }
}, 240_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('D14 4.1.3: one meaning of "announced" with the controls test (V-SM-08, V-SM-09, L-SM-09, L-SM-01)', () => {
  it('RED: a status region created together with its text, or hidden from assistive technology, is not announced', () => {
    expect(failed('status-created-with-text', '4.1.3').map((f) => f.detail)).toEqual([expect.stringContaining('Your request was saved.')]);
    expect(failed('status-aria-hidden', '4.1.3').map((f) => f.detail)).toEqual([expect.stringContaining('Your request was saved.')]);
  });
  it('look-alikes: an alert added with its text, and a status region that was there before, are announced', () => {
    expect(failed('alert-inserted', '4.1.3')).toEqual([]);
    expect(failed('status-existing', '4.1.3')).toEqual([]);
    expect(of('status-existing', '4.1.3', 'no_failures_found').length).toBeGreaterThan(0);
  });
});

describe('D15 3.2.2: advised beforehand (V-OI-01, L-OI-04)', () => {
  it('RED stays: a jump menu that says nothing fails', () => {
    expect(failed('jump-silent', '3.2.2')).toHaveLength(1);
  });
  it('look-alikes: the same jump menu, advised in its label or in the text after it, is clean', () => {
    for (const p of ['jump-advised', 'jump-advised-after']) {
      expect(failed(p, '3.2.2'), p).toEqual([]);
      expect(of(p, '3.2.2', 'no_failures_found').some((f) => f.detail.includes('as the page says beforehand')), p).toBe(true);
    }
  });
});

describe('3.3.2 group: D8 required after sending, D17 G167 words, D19 phone width and vanishing labels, D20 CSS-drawn text, Q6 runs', () => {
  it('RED D8: fields a script demands, with nothing visible saying so, fail; the optional convention is clean', () => {
    expect(failed('req-by-script', '3.3.2').map((f) => f.detail)).toEqual([
      expect.stringContaining('Enter your full name'), expect.stringContaining('Enter your full name'), expect.stringContaining('Enter your full name'),
    ]);
    expect(failed('req-optional-convention', '3.3.2')).toEqual([]);
  });
  it('look-alike D20: a required marker drawn as a picture by CSS, and label text drawn by CSS, are seen', () => {
    expect(failed('req-css-icon', '3.3.2')).toEqual([]);
    expect(failed('label-css-content', '3.3.2')).toEqual([]);
  });
  it('RED D19: labels hidden at a phone\'s width fail there; a floating label that moves stays clean', () => {
    expect(failed('label-hidden-mobile', '3.3.2').map((f) => f.detail)).toEqual([expect.stringContaining('390 px'), expect.stringContaining('390 px')]);
    expect(failed('label-floating', '3.3.2')).toEqual([]);
  });
  it('RED D19: a label that disappears once people type fails', () => {
    expect(failed('label-vanishing', '3.3.2').map((f) => f.detail)).toEqual([expect.stringContaining('then disappears'), expect.stringContaining('then disappears')]);
  });
  it('RED Q6: a heading over two fields that ask different things fails both; a phone in three parts under one heading is undecided', () => {
    expect(failed('heading-two-fields', '3.3.2')).toHaveLength(2);
    expect(failed('heading-phone-parts', '3.3.2')).toEqual([]);
    expect(of('heading-phone-parts', '3.3.2', 'not_testable').length).toBeGreaterThan(0);
  });
  it('RED D17: a Subscribe button labels no email field; "Apply promo code" labels its field', () => {
    expect(failed('g167-subscribe', '3.3.2').map((f) => f.detail)).toEqual([expect.stringContaining('names an action')]);
    expect(failed('g167-promo', '3.3.2')).toEqual([]);
  });
});

describe('3.3.7 step-follow: steps by cause (D5), sameness (D6), availability (D7; ruling Q1)', () => {
  it('RED D5: a second form the first one\'s send reveals asks again for the applicant name: fails', () => {
    expect(failed('step-two-forms', '3.3.7').map((f) => f.detail)).toEqual([expect.stringContaining('Applicant name')]);
  });
  it('RED D6: the same person\'s email asked again in other words fails', () => {
    expect(failed('step-two-forms-other-words', '3.3.7').map((f) => f.detail)).toEqual([expect.stringContaining('Email for your review')]);
  });
  it('RED D5: a step a script renders on demand asks again for the contact email: fails', () => {
    expect(failed('step-rendered', '3.3.7').map((f) => f.detail)).toEqual([expect.stringContaining('Contact email')]);
  });
  it('look-alikes: carried forward, a signature, a second applicant, a reuse button, a datalist offering it, shown as text', () => {
    for (const p of ['step-two-forms-populated', 'step-two-forms-signature', 'step-two-forms-second-applicant', 'step-two-forms-copy-button', 'step-two-forms-datalist', 'step-rendered-shown']) {
      expect(failed(p, '3.3.7'), p).toEqual([]);
    }
  });
});

describe('3.3.1 symbols (D9), 3.3.3 browser messages (D11), 3.3.8 log-in fields (D23), 3.3.4 bank details (D22), 1.3.5 legends and places (D21)', () => {
  it('RED D9: a red asterisk the only error text fails 3.3.1; a real message tied to the field does not', () => {
    expect(failed('validator-asterisk', '3.3.1').length).toBeGreaterThan(0);
    expect(failed('validator-message', '3.3.1')).toEqual([]);
  });
  it('RED D11: a pattern with no title gets only the browser\'s "requested format": fails; with a title, clean', () => {
    expect(failed('pattern-no-title', '3.3.3').map((f) => f.detail)).toEqual([expect.stringContaining('requested format')]);
    expect(failed('pattern-titled', '3.3.3')).toEqual([]);
  });
  it('D23 (fix round, Sol S6): a user-name field that refuses a paste is listed, never failed; one that trims a paste is clean', () => {
    expect(failed('login-username-paste', '3.3.8')).toEqual([]);
    expect(of('login-username-paste', '3.3.8', 'not_testable').map((f) => f.target)).toEqual([expect.stringContaining('User name')]);
    expect(failed('login-username-trim', '3.3.8')).toEqual([]);
  });
  it('D22 (fix round, Sol S4): bank details paid on one press are listed, never failed; with an inline confirmation, clean', () => {
    expect(failed('pay-bank', '3.3.4')).toEqual([]);
    expect(of('pay-bank', '3.3.4', 'not_testable').map((f) => f.detail)).toEqual([expect.stringContaining('bank account details')]);
    expect(failed('pay-bank-confirm', '3.3.4')).toEqual([]);
  });
  it('RED D21: a date of birth in three lists under its legend needs bday tokens; the address of a pothole is no one\'s', () => {
    expect(failed('dob-parts', '1.3.5').map((f) => f.detail)).toEqual([
      expect.stringContaining('bday-month'), expect.stringContaining('bday-day'), expect.stringContaining('bday-year'),
    ]);
    expect(failed('pothole-address', '1.3.5')).toEqual([]);
  });
});

describe('D12 4.1.3 after a choice (V-SM-04, L-SM-01, L-SM-07)', () => {
  it('RED: a filter that rewrites its result count in a plain paragraph fails', () => {
    expect(failed('filter-count-quiet', '4.1.3').map((f) => f.detail)).toEqual([expect.stringContaining('Showing')]);
  });
  it('look-alikes: the same count in a status region, and a hint the choice reveals, are clean', () => {
    expect(failed('filter-count-live', '4.1.3')).toEqual([]);
    expect(failed('choice-reveals-hint', '4.1.3')).toEqual([]);
  });
});
