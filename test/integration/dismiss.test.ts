// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// proveDismiss (src/probes/dismiss.ts): proving a box can be dismissed by keyboard, in real Chromium,
// with the probe runner's request guard. One fixture page, one way of closing per ?mode=.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proveDismiss, type DismissResult } from '../../src/probes/dismiss.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const results = new Map<string, { r: DismissResult; focus: string; sy: number }>();
/** The "#" link with `noHashLinks` (page-load pop-ups, popupAside.ts): never pressed. */
let hashNoHash: DismissResult | undefined;
const MODES = ['button', 'link', 'space', 'broken', 'mouse', 'returns', 'js', 'submit', 'request', 'push', 'unnamed',
  'textfield', 'replace', 'scrollback', 'wrapper', 'late', 'get', 'shadow', 'hash', 'pushsame',
  'absreplace', 'penone', 'headerunder', 'late2'];

beforeAll(async () => {
  server = await startFixtureServer('dismiss');
  browser = await chromium.launch();
  const probe: PageProbe = {
    id: 'dismiss-test', criteria: ['1.4.10'], kind: 'interaction', tier: 'core', timeoutMs: 20_000, isolate: true,
    async run(ctx) {
      await ctx.page.evaluate(() => window.scrollTo(0, 300), undefined);
      if (new URL(ctx.url).searchParams.get('mode') === 'hash') hashNoHash = await proveDismiss(ctx, '#box', { noHashLinks: true });
      const r = await proveDismiss(ctx, '#box');
      const after = await ctx.page.evaluate(() => ({ focus: document.activeElement?.id ?? '', sy: scrollY }), undefined);
      results.set(new URL(ctx.url).searchParams.get('mode')!, { r, ...after });
      if (process.env.DISMISS_DEBUG) console.log('DISMISS', new URL(ctx.url).searchParams.get('mode'), JSON.stringify(r));
      return [];
    },
  };
  await runProbes(browser as unknown as BrowserLike, MODES.map((m, index) => ({ url: `${server.origin}/?mode=${m}`, index })), [probe], { userAgent: 'grnted-test' });
}, 240_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('proveDismiss', () => {
  it('dismisses with Enter on a button or a link, and with Space on a custom button', () => {
    expect(results.get('button')!.r).toMatchObject({ dismissed: true, by: { name: 'Accept', key: 'Enter' } });
    expect(results.get('link')!.r).toMatchObject({ dismissed: true, by: { name: 'Close', key: 'Enter' } });
    expect(results.get('space')!.r).toMatchObject({ dismissed: true, by: { name: 'Dismiss', key: 'Space' } });
  });

  it('puts focus and the scroll position back', () => {
    for (const m of ['button', 'broken']) expect(results.get(m), m).toMatchObject({ focus: 'page-btn', sy: 300 });
  });

  it('is not dismissed when the control does nothing, only a mouse can close it, or the box comes back', () => {
    expect(results.get('broken')!.r).toMatchObject({ dismissed: false, why: expect.stringContaining('does not close it') });
    expect(results.get('mouse')!.r).toMatchObject({ dismissed: false, why: 'nothing in it that closes it can be reached with the keyboard' });
    expect(results.get('returns')!.r).toMatchObject({ dismissed: false, why: 'it comes back right after it is closed' });
    expect(results.get('unnamed')!.r).toMatchObject({ dismissed: false, tried: [] });
  });

  it('never presses a javascript: link or a form\'s submit button', () => {
    for (const m of ['js', 'submit']) expect(results.get(m)!.r, m).toMatchObject({ dismissed: false, tried: [] });
  });

  // Grok round 1 (2026-11-07): each was dismissed (or pressed) on 55f79a60.
  it('never presses a text field, even one named Close (Enter there sends its form)', () => {
    expect(results.get('textfield')!.r).toMatchObject({ dismissed: false, tried: [] });
  });

  it('is not dismissed when the close puts another box in its place, a scroll or a timer brings it back, or a part of it still shows', () => {
    expect(results.get('replace')!.r).toMatchObject({ dismissed: false, why: expect.stringContaining('does not close it') });
    for (const m of ['scrollback', 'late']) expect(results.get(m)!.r, m).toMatchObject({ dismissed: false, why: 'it comes back right after it is closed' });
    expect(results.get('wrapper')!.r).toMatchObject({ dismissed: false, why: expect.stringContaining('does not close it') });
  });

  it('any request the press makes (an allowed GET too), or a new history entry for the same address, means not dismissed', () => {
    expect(results.get('get')!.r).toMatchObject({ dismissed: false, request: expect.stringContaining('/api/consent'), why: expect.stringContaining('sends a request to the site') });
    expect(results.get('pushsame')!.r).toMatchObject({ dismissed: false, why: expect.stringContaining("changes the page's address") });
  });

  it('with noHashLinks, never presses a link to "#" (and the box stays for the next try)', () => {
    expect(hashNoHash).toMatchObject({ dismissed: false, tried: [] });
  });

  it('presses a close button inside a shadow root, and a link to "#" that only changes the fragment', () => {
    expect(results.get('shadow')!.r).toMatchObject({ dismissed: true, by: { name: 'Close', key: 'Enter' } });
    expect(results.get('hash')!.r).toMatchObject({ dismissed: true, by: { name: 'Close', key: 'Enter' } });
  });

  // Grok round 2 (2026-11-07): the first three were dismissed on 8cb45f8e, the last was not.
  it('is not dismissed when anything new paints over the old place (any position, pointer-events none too) or it is back 2 s later', () => {
    for (const m of ['absreplace', 'penone']) expect(results.get(m)!.r, m).toMatchObject({ dismissed: false, why: expect.stringContaining('does not close it') });
    expect(results.get('late2')!.r).toMatchObject({ dismissed: false, why: 'it comes back right after it is closed' });
  });

  it('is dismissed when the close reveals a layer that stayed on screen before (a bar the banner lay over)', () => {
    expect(results.get('headerunder')!.r).toMatchObject({ dismissed: true, by: { name: 'Close', key: 'Enter' } });
  });

  it('a request the guard held, or a change of address, means not dismissed', () => {
    expect(results.get('request')!.r).toMatchObject({ dismissed: false, held: expect.objectContaining({ kind: 'blocked' }), why: expect.stringContaining('sends a request') });
    expect(results.get('push')!.r).toMatchObject({ dismissed: false, why: expect.stringContaining("changes the page's address") });
  });
});
