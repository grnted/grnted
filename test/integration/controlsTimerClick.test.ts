// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What the page writes by itself during a click is never the click's (the lead's cut, batch 17, 2026-11-13): the
// controls test's click window, at the level of its in-page kit in real Chromium, so that the page's own timer runs
// inside the window every time, not by chance (test/fixtures/controls/pointer-countdown.html and
// pointer-inert-countdown.html).
// The report: on a loaded machine the controls test credited a click with a countdown's tick beside it ("a mouse
// click changes “43 seconds” to “42 seconds”") when the tick fell in the click's window: the click's own events had
// changed something else, and every text that changed in the window was then counted as the click's.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROLS_KEY, controlsKit, installControlsKit, type ControlCandidate, type Effect } from '../../src/probes/controls/page.js';
import { clickDid, DISCLOSURE_NAME, operationFinding, SELF_DURING_CLICK, STATUS_TEXT } from '../../src/probes/controls/rules.js';
import { LISTENER_HOOK_SCRIPT } from '../../src/probes/listeners.js';
import { LIVE_REGION_SELECTOR } from '../../src/probes/liveRegion.js';
import { ACTION_NAME } from '../../src/probes/pointerKit.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('controls');
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * One click as the controls test makes it (the window starts as the pointer comes to rest on the control, then the
 * state before, the click, the wait, the state after), with the wait set by the test: `waitMs` is longer than the
 * page's own 1 s tick, so the countdown changes inside the window every time. `since`: the window's start is given to
 * the kit (the cut); without it, the comparison as it was before the cut (the red).
 */
async function click(file: string, id: string, withSince: boolean, waitMs = 1600): Promise<Effect | null> {
  const context = await browser.newContext();
  await context.addInitScript({ content: LISTENER_HOOK_SCRIPT });
  const page: Page = await context.newPage();
  try {
    await page.goto(`${server.origin}/${file}`);
    expect(await page.evaluate(installControlsKit, { key: CONTROLS_KEY, action: ACTION_NAME, status: STATUS_TEXT, disclosure: DISCLOSURE_NAME, live: LIVE_REGION_SELECTOR })).toBe(true);
    const k = <R>(op: string, a: unknown = {}) => controlsKit<R>({ page }, op, a);
    const box = (await page.locator(`#${id}`).boundingBox())!;
    // As the test does: a control that takes focus has it before the click (focus that only moves is no effect).
    await page.focus(`#${id}`);
    const since = await k<number>('clock');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 2 });
    await page.waitForTimeout(100);
    await k('begin', { i: -1, label: 'p' });
    await page.mouse.down();
    await page.mouse.up();
    return await k<Effect | null>('effect', { i: -1, a: 'p', b: 'q', ms: waitMs, ...(withSince ? { since } : {}) });
  } finally {
    await context.close();
  }
}

const where = (e: Effect | null) => (e?.where ?? []).join(' ');

describe('a page timer\'s write inside a click\'s window is never the click\'s', () => {
  it('RED: without the cut, the countdown\'s tick is what the click is credited with (the click\'s own change came second)', async () => {
    const e = await click('pointer-countdown.html', 'attach', false);
    expect(e?.direct).toBe(true);
    expect(e?.textChange?.from).toMatch(/seconds/);
    expect(clickDid(e, [])?.what).toMatch(/seconds/);
  }, 30_000);

  it('the countdown beside a control is left out: the click is credited with its own message only', async () => {
    const e = await click('pointer-countdown.html', 'attach', true);
    expect(e?.direct).toBe(true);
    expect(e?.self).toBeGreaterThanOrEqual(1);
    expect(e?.textChange).toEqual({ from: '', to: 'Field sketch added to this order.' });
    expect(where(e)).not.toMatch(/#left/);
    expect(clickDid(e, [])?.what).toContain('Field sketch added to this order.');
    expect(clickDid(e, [])?.what).not.toMatch(/seconds/);
  }, 30_000);

  it('RED: without the cut, a click that changes nothing anyone sees is credited with the countdown\'s tick', async () => {
    const e = await click('pointer-inert-countdown.html', 'keep', false);
    expect(e?.direct).toBe(true);
    expect(clickDid(e, [])?.what).toMatch(/seconds/);
  }, 30_000);

  it('look-alike: a click that does nothing beside a self-ticking counter has nothing of its own left, and is not testable, never failed', async () => {
    const e = await click('pointer-inert-countdown.html', 'keep', true);
    expect(e?.changed).toBe(false);
    expect(e?.self).toBeGreaterThanOrEqual(1);
    expect(clickDid(e, [])).toBeNull();
    const keep: ControlCandidate = { i: 0, path: '#keep', name: 'Keep my answers', tag: 'div', role: 'button', kind: 'custom', tabbable: true, focusable: true, types: ['click'], pointerOnly: false };
    const f = operationFinding(keep, { kind: 'self' });
    expect(f?.status).toBe('not_testable');
    expect(f?.detail).toContain(SELF_DURING_CLICK);
  }, 30_000);
});
