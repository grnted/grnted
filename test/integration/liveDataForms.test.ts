// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Self-updating live data is never a form's answer (batch 17, 2026-11-12): the forms test's empty-submit attempt
// (also the live screen-reader pass's) in real Chromium, at the level of the in-page agent so that the moment the
// page's own timer writes is decided here, not by chance (test/fixtures/act-watch/live-board-*.html).
// The report: a trip-preferences form with nothing to get wrong sits beside a live arrivals panel; when the
// arrival time changed in the half second after the submit, it was read as the form's message and 4.1.3 failed
// ("the form showed 1 error message (for example “7 min”) that screen readers do not announce"), on one run in
// two or three of the same page.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAnswer, FORMS_CAPS, judgeAttempt, judgeValid, OUTSIDE_ERROR } from '../../src/probes/forms.js';
import { callFormsAgent, installFormsAgent, type CollectResult, type ScannedPage } from '../../src/probes/formsPage.js';
import { LISTENER_HOOK_SCRIPT } from '../../src/probes/listeners.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const requests: string[] = [];

beforeAll(async () => {
  server = await startFixtureServer('act-watch', {}, { onRequest: (req) => requests.push(`${req.method} ${req.url}`) });
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * One empty-submit attempt as the forms test makes it (observe, arm, submit, wait, collect, judge), on a page with
 * the listener hook, with the wait between the submit and the reading set by the test: `waitMs` is long enough for
 * the page's own 1 s timer to run once in the window.
 */
async function attempt(file: string, waitMs: number): Promise<{ obs: CollectResult; judged: ReturnType<typeof judgeAttempt> }> {
  const context = await browser.newContext();
  await context.addInitScript({ content: LISTENER_HOOK_SCRIPT });
  const page: Page = await context.newPage();
  try {
    await page.goto(`${server.origin}/${file}`);
    expect(await page.evaluate(installFormsAgent, FORMS_CAPS)).toBe(true);
    const call = <T>(op: string, arg?: unknown) => page.evaluate(callFormsAgent, { op, arg }) as Promise<T>;
    await call('record');
    const scanned = await call<ScannedPage>('scan');
    const form = scanned.forms[0]!;
    await call('observe', { form: form.index });
    expect(await call<boolean>('arm', { form: form.index })).toBe(true);
    await call('submit', { form: form.index, button: form.submitter?.ref ?? -1 });
    await page.waitForTimeout(waitMs);
    const obs = await call<CollectResult>('collect', { outside: OUTSIDE_ERROR });
    return { obs, judged: judgeAttempt(form, new Map(scanned.fields.map((f) => [f.ref, f])), obs, [], 'empty') };
  } finally {
    await context.close();
  }
}

describe('live data beside or in a form is not the form\'s answer', () => {
  it('RED: an arrival time that changes beside the form while the submit is watched is not judged (it failed 4.1.3)', async () => {
    const { obs, judged } = await attempt('live-board-outside.html', 1300);
    expect(judged.findings).toEqual([]);
    expect(judged.outcome).toBe('silent');
    // The agent saw the arrival time change, and saw the page's own timer write it.
    const eta = obs.messages.filter((m) => /^\d min$/.test(m.text));
    expect(eta).toHaveLength(1);
    expect(eta[0]).toMatchObject({ timer: true, near: -1 });
    expect(eta[0]!.inForm).toBeUndefined();
    expect(attemptAnswer(eta[0]!)).toBe(false);
    expect(judged.reason).toMatch(/is written by a timer the page runs by itself, so it is not the form's answer/);
  }, 30_000);

  it('RED: the same live value inside the form itself is not judged either', async () => {
    const { obs, judged } = await attempt('live-board-inside.html', 1300);
    expect(judged.findings).toEqual([]);
    expect(judged.outcome).toBe('silent');
    const eta = obs.messages.filter((m) => /^\d min$/.test(m.text));
    expect(eta).toHaveLength(1);
    expect(eta[0]).toMatchObject({ timer: true, inForm: true });
  }, 30_000);

  it('RED: a live value that describes a field, changed in an earlier attempt\'s window, is not the next attempt\'s answer', async () => {
    // The next attempt finds the field's description "changed since the form was first tried" and took it for what
    // the page says about the field now; the filled-in attempt then failed 4.1.3 with it.
    const context = await browser.newContext();
    await context.addInitScript({ content: LISTENER_HOOK_SCRIPT });
    const page: Page = await context.newPage();
    try {
      await page.goto(`${server.origin}/live-board-described.html`);
      expect(await page.evaluate(installFormsAgent, FORMS_CAPS)).toBe(true);
      const call = <T>(op: string, arg?: unknown) => page.evaluate(callFormsAgent, { op, arg }) as Promise<T>;
      await call('record');
      const scanned = await call<ScannedPage>('scan');
      const form = scanned.forms[0]!;
      const byRef = new Map(scanned.fields.map((f) => [f.ref, f]));
      const once = async (waitMs: number) => {
        await call('observe', { form: form.index });
        expect(await call<boolean>('arm', { form: form.index })).toBe(true);
        await call('submit', { form: form.index, button: form.submitter?.ref ?? -1 });
        await page.waitForTimeout(waitMs);
        return call<CollectResult>('collect', { outside: OUTSIDE_ERROR });
      };
      // First attempt: the page's 1 s timer writes the arrival time in the window.
      const first = await once(1300);
      expect(judgeAttempt(form, byRef, first, [], 'empty')).toMatchObject({ outcome: 'silent', findings: [] });
      // Second attempt, read before the timer runs again: nothing changes in its window.
      const second = await once(100);
      for (const m of second.messages) expect(m, JSON.stringify(m)).toMatchObject({ timer: true });
      expect(judgeAttempt(form, byRef, second, [], 'format')).toMatchObject({ outcome: 'silent', findings: [] });
      expect(judgeValid(form, second, [])).toMatchObject({ outcome: 'silent', findings: [] });
    } finally {
      await context.close();
    }
  }, 30_000);

  it('look-alike: the form\'s own answer, written into the form by a timer the submit starts, still fails 4.1.3 while the panel keeps ticking', async () => {
    const { obs, judged } = await attempt('live-board-own-answer.html', 1300);
    const own = obs.messages.find((m) => /Choose at least one way/.test(m.text))!;
    expect(own).toMatchObject({ inForm: true });
    expect(own.timer).toBeUndefined();
    expect(judged.outcome).toBe('client');
    expect(judged.findings.filter((f) => f.criterion === '4.1.3')).toEqual([
      { criterion: '4.1.3', status: 'failed', target: expect.any(String), detail: expect.stringContaining('Choose at least one way to board before you update.') },
    ]);
    // The arrival time changed in the same window and is not among what the form "showed".
    expect(judged.findings.some((f) => /\d min/.test(f.detail))).toBe(false);
    expect(judged.errors.some((e) => /^\d min$/.test(e.text))).toBe(false);
  }, 30_000);

  it('look-alike: an error summary above the form, written a moment after the submit, still fails 4.1.3', async () => {
    const { obs, judged } = await attempt('live-board-summary.html', 1300);
    const summary = obs.messages.find((m) => /There is a problem/.test(m.text))!;
    expect(summary.near).toBe(-1);
    expect(summary.timer).toBeUndefined();
    expect(judged.outcome).toBe('client');
    expect(judged.findings.filter((f) => f.criterion === '4.1.3' && f.status === 'failed')).toHaveLength(1);
    expect(judged.findings[0]!.detail).toContain('There is a problem');
  }, 30_000);

  it('nothing but GET requests reached the server', () => {
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((r) => !r.startsWith('GET '))).toEqual([]);
  });
});
