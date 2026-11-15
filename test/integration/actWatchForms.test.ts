// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Act and watch, forms (act-watch lane, 2026-11-11; src/probes/forms.ts `judgeValid`, `noSuggestion`, the 3.3.1
// "item in error not identified" rule; src/probes/formsPage.ts `collect`'s `outside`, kept marks, churn). In real
// Chromium on synthetic fixtures (test/fixtures/act-watch/): the form is filled in with test values and sent with
// nothing leaving the browser, and what the page then shows is judged; an error message that names no field; a
// wrong format the page detects and says nothing about. Each failure has look-alikes that must stay clean.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FORMS_CAPS, formsProbe, OUTSIDE_STATUS } from '../../src/probes/forms.js';
import { callFormsAgent, installFormsAgent, type CollectResult } from '../../src/probes/formsPage.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, CriterionStatus, ProbeFinding, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const requests: { method: string; url: string }[] = [];
const runs = new Map<string, ProbeRun>();
const REVIEW = ['f1-beside-wrapper', 'f1-example-after', 'f2-output', 'f3-counter-help', 'f3-rotating', 'f3-late-announce', 'f3-late-announce-slow', 'f4-legend', 'f4-focus', 'f4-captcha', 'f4-signin', 'f5-jsonp'];
const PAGES = [...REVIEW, 'late-form', 'valid-quiet', 'valid-status', 'valid-focus', 'unidentified', 'valid-toast-live', 'identified', 'no-suggestion', 'suggestion', 'suggestion-same-text', 'ticker-quiet', 'server-form'];

const of = (page: string, criterion: string, status?: CriterionStatus): ProbeFinding[] =>
  runs.get(page)!.findings.filter((f) => f.criterion === criterion && (!status || f.status === status));
const failed = (page: string, criterion: string) => of(page, criterion, 'failed');

beforeAll(async () => {
  server = await startFixtureServer('act-watch', {}, { onRequest: (req: IncomingMessage) => { requests.push({ method: req.method ?? '', url: req.url ?? '' }); } });
  browser = await chromium.launch();
  const out = await runProbes(browser as unknown as BrowserLike, PAGES.map((p, index) => ({ url: `${server.origin}/${p}.html`, index })), [formsProbe],
    { userAgent: 'grnted-test', settleMs: 200, full: true });
  for (const r of out) runs.set(new URL(r.page).pathname.slice(1, -5), r);
  await new Promise((r) => setTimeout(r, 500));
}, 180_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('the filled-in attempt (4.1.3)', () => {
  it('RED: a form whose own script answers a filled-in form with a sentence in a plain paragraph fails, with the sentence', () => {
    const f = failed('valid-quiet', '4.1.3');
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain('Your report is ready to review');
    expect(f[0]!.detail).toContain('focus stayed on "Send request"');
  });

  it('RED: a form the page mounts 1.5 s after it loads is waited for and tested (before: "no form fields")', () => {
    expect(failed('late-form', '4.1.3').map((x) => x.detail)).toEqual([expect.stringContaining('Thanks, your request was received.')]);
  });

  it('RED: the same answer in a toast elsewhere on the page fails too, said as elsewhere', () => {
    const f = failed('unidentified', '4.1.3').filter((x) => x.detail.startsWith('filled in'));
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain('“Your alert settings are updated.” elsewhere on the page'.replace(/[“”]/g, '"'));
  });

  it('look-alikes: role=status, focus moved to the message, a polite live region toast, a form that sends to the server, a ticker beside a quiet form', () => {
    for (const p of ['valid-status', 'valid-focus', 'valid-toast-live', 'suggestion', 'no-suggestion', 'identified']) expect(failed(p, '4.1.3'), p).toEqual([]);
    expect(of('valid-status', '4.1.3', 'no_failures_found').some((x) => x.detail.includes('screen readers are told about'))).toBe(true);
    // The form that sends: nothing judged from the filled-in attempt, and nothing reached the server.
    expect(failed('server-form', '4.1.3')).toEqual([]);
    expect(requests.filter((r) => r.url.startsWith('/aw-join'))).toEqual([]);
    // A notice that rotates by itself outside the form is never taken for the form's answer.
    expect(failed('ticker-quiet', '4.1.3')).toEqual([]);
    expect(runs.get('ticker-quiet')!.findings.some((x) => /results found|updated|saved|completed/.test(x.detail))).toBe(false);
  });
});

describe('the item in error not identified (3.3.1)', () => {
  it('RED: an empty submit answered "Could not update your alerts." in a toast, with nothing about the email field, fails', () => {
    const f = failed('unidentified', '3.3.1');
    expect(f.length).toBeGreaterThanOrEqual(1);
    expect(f[0]!.detail).toContain('"Could not update your alerts."');
    expect(f[0]!.detail).toContain('names none of the form');
  });

  it('look-alike: the same toast beside a message tied to the email field passes', () => {
    expect(failed('identified', '3.3.1')).toEqual([]);
  });
});

describe('no suggestion (3.3.3)', () => {
  it('RED: a wrong email the page marks only with a red border (and judges again on each submit) fails', () => {
    const f = failed('no-suggestion', '3.3.3');
    expect(f.map((x) => x.target)).toEqual(['Email address (email field)']);
    expect(f[0]!.detail).toContain('nothing says what is expected');
  });

  it('look-alike: the same page with an error tied to the field that gives the format passes', () => {
    expect(failed('suggestion', '3.3.3')).toEqual([]);
    expect(failed('suggestion', '3.3.1')).toEqual([]);
  });

  it('look-alike (gold r1): the same error text left in place on the next submit is that submit\'s answer, never a mark without text', () => {
    // The page writes "Enter an email address like name@example.com" for an empty and for a wrong email alike, so the
    // wrong-format submit changes no text: the text tied to the field still answers it.
    expect(failed('suggestion-same-text', '3.3.3')).toEqual([]);
    expect(failed('suggestion-same-text', '3.3.1')).toEqual([]);
    expect(of('suggestion-same-text', '3.3.3', 'not_testable')).toEqual([]);
  });
});

describe('review r1 look-alikes: nothing here may fail the criterion the case is about', () => {
  it('F1: untied error text beside the field\'s wrapper with the same words for empty and wrong; a format example after the field', () => {
    expect(failed('f1-beside-wrapper', '3.3.3')).toEqual([]);
    expect(failed('f1-beside-wrapper', '3.3.1')).toEqual([]);
    expect(failed('f1-example-after', '3.3.3')).toEqual([]);
  });
  it('F2: a result written into <output> (implicit role status)', () => {
    expect(failed('f2-output', '4.1.3')).toEqual([]);
  });
  it('F3: a counter and choice-dependent help on a quiet form; notices that change by class on a 6 s period, outside and in the form\'s area; an announcement 700 ms after the text', () => {
    expect(failed('f3-counter-help', '4.1.3')).toEqual([]);
    for (const c of ['3.3.1', '4.1.3']) expect(failed('f3-rotating', c), c).toEqual([]);
    expect(failed('f3-late-announce', '4.1.3')).toEqual([]);
    // Spoken 1.3 s after the text: while the test still watches whether the text stays as it is.
    expect(failed('f3-late-announce-slow', '4.1.3')).toEqual([]);
  });
  it('F4: a message that names a group by its legend, focus moved to the field, a CAPTCHA, a sign-in message', () => {
    for (const p of ['f4-legend', 'f4-focus', 'f4-captcha', 'f4-signin']) expect(failed(p, '3.3.1'), p).toEqual([]);
  });
  it('F5: a form that sends by JSONP is not judged, and nothing reaches the server', () => {
    expect(failed('f5-jsonp', '4.1.3')).toEqual([]);
    expect(failed('f5-jsonp', '3.3.1')).toEqual([]);
    expect(requests.filter((r) => r.url.startsWith('/aw-jsonp'))).toEqual([]);
  });
});

describe('what the agent takes from outside the form (churn, direct: review r1 F3b)', () => {
  it('only what the submit\'s own events wrote, and never what also changed while nothing was being submitted', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<main><form id="f"><label for="a">Name</label><input id="a"><label for="b">Note</label><input id="b"><button>Send</button></form></main>
<p id="ticker">Library hours updated</p><p id="toast"></p><p id="late"></p>
<script>document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault();
  document.getElementById('ticker').textContent = 'Pool schedule saved for winter';
  document.getElementById('toast').textContent = 'Your comment has been saved.';
  setTimeout(() => { document.getElementById('late').textContent = '3 results found for park closures'; }, 50); });</script>`);
      expect(await page.evaluate(installFormsAgent, FORMS_CAPS)).toBe(true);
      const call = (op: string, arg?: unknown) => page.evaluate(callFormsAgent, { op, arg });
      await call('record');
      await call('scan');
      // The ticker changes by itself while no attempt is armed (by class, as rotators do, and by text).
      await page.evaluate(() => { const t = document.getElementById('ticker')!; t.className = 'shown'; t.textContent = '3 results found for detours'; });
      await page.waitForTimeout(50);
      expect(await call('arm', { form: 0 })).toBe(true);
      await call('submit', { form: 0, button: -1 });
      await page.waitForTimeout(150);
      const got = await call('collect', { outside: OUTSIDE_STATUS }) as CollectResult;
      // The toast (written by the submit's handler) is taken; the ticker (churned) and the late line (a timer, not
      // the submit's own dispatch) are not.
      expect(got.messages.map((m) => [m.text, m.outside ?? false, m.direct ?? false])).toEqual([['Your comment has been saved.', true, true]]);
    } finally {
      await page.close();
    }
  });
});
